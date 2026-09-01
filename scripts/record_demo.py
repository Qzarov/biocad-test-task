"""Record the demo GIF: Excel import → chat edit → export.

Needs the app running (backend on :8000, frontend on :5173) and a working
OPENROUTER_API_KEY in backend/.env, because the chat step drives the real agent.

    pip install playwright && python -m playwright install chromium
    python scripts/record_demo.py            # writes docs/demo.gif

Options:
    --url        front end URL (default http://127.0.0.1:5173)
    --out        output gif (default docs/demo.gif)
    --message    the chat request to demonstrate
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SAMPLE = ROOT / "samples" / "example_plan.xlsx"
DEFAULT_MESSAGE = (
    "Перенеси квалификацию PQ на две недели позже, переназначь задачи Титова С. "
    "на Белову Н. и добавь задачу «Аудит поставщика сырья» на 10 дней перед поставкой"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:5173")
    parser.add_argument("--out", default=str(ROOT / "docs" / "demo.gif"))
    parser.add_argument("--message", default=DEFAULT_MESSAGE)
    parser.add_argument("--fps", type=int, default=10)
    parser.add_argument("--width", type=int, default=1280)
    return parser.parse_args()


def record(args: argparse.Namespace, video_dir: Path) -> Path:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(
            viewport={"width": 1600, "height": 900},
            record_video_dir=str(video_dir),
            record_video_size={"width": 1600, "height": 900},
        )
        page = context.new_page()
        page.goto(args.url, wait_until="networkidle")
        page.wait_for_timeout(1800)

        # 1. upload the sample workbook
        page.set_input_files("input[type=file]", str(SAMPLE))
        page.wait_for_selector(".gantt-row")
        page.wait_for_timeout(2200)

        # 2. open a task to show the details modal, then close it
        page.locator(".gantt-row").nth(9).dblclick()
        page.wait_for_timeout(2200)
        page.click("button:has-text('Закрыть')")
        page.wait_for_timeout(800)

        # 3. ask the agent for a bulk edit and watch the chart react
        page.fill(".chat__composer textarea", args.message)
        page.wait_for_timeout(700)
        page.click("button:has-text('Отправить')")
        page.wait_for_timeout(2000)
        try:
            page.wait_for_function(
                "() => !document.querySelector('.chat__composer textarea').disabled",
                timeout=180_000,
            )
        except Exception:
            print("warning: the agent turn did not finish in time", file=sys.stderr)
        page.wait_for_timeout(3500)

        # 4. export back to Excel
        with page.expect_download() as download:
            page.click("a:has-text('Скачать Excel')")
        saved = download.value.suggested_filename
        print(f"exported {saved}")
        page.wait_for_timeout(1800)

        video = page.video.path() if page.video else None
        context.close()
        browser.close()
        if not video:
            raise SystemExit("playwright did not produce a video")
        return Path(video)


def to_gif(webm: Path, out: Path, fps: int, width: int) -> None:
    if not shutil.which("ffmpeg"):
        raise SystemExit("ffmpeg not found — install it or keep the .webm")
    out.parent.mkdir(parents=True, exist_ok=True)
    palette = out.with_suffix(".palette.png")
    scale = f"fps={fps},scale={width}:-1:flags=lanczos"
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(webm), "-vf", f"{scale},palettegen=stats_mode=diff", str(palette)],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        [
            "ffmpeg", "-y", "-i", str(webm), "-i", str(palette),
            "-lavfi", f"{scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3",
            str(out),
        ],
        check=True,
        capture_output=True,
    )
    palette.unlink(missing_ok=True)
    print(f"wrote {out} ({out.stat().st_size / 1_048_576:.1f} MB)")


def main() -> None:
    args = parse_args()
    if not SAMPLE.exists():
        raise SystemExit(f"missing {SAMPLE}; run backend/scripts/make_example_xlsx.py first")
    with tempfile.TemporaryDirectory() as tmp:
        webm = record(args, Path(tmp))
        shutil.copy(webm, Path(args.out).with_suffix(".webm"))
        to_gif(webm, Path(args.out), args.fps, args.width)


if __name__ == "__main__":
    main()
