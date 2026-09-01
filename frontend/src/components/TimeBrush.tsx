import { useEffect, useRef, useState } from "react";
import type { Schedule } from "../types";

/** Окно просмотра по времени: ручки задают масштаб, середина — навигацию.
 *
 * Одна шкала вместо двух контролов (масштаб + прокрутка): человек думает не
 * «ширина колонки 74px», а «покажи мне вот этот кусок проекта». Из окна
 * выводится и масштаб, и позиция прокрутки диаграммы.
 *
 * Значения — смещения в днях от старта проекта, потому что это единственная
 * величина, одинаково понятная и шкале, и планировщику.
 */
export const MIN_WINDOW_DAYS = 7;

interface Props {
  schedule: Schedule;
  totalDays: number;
  from: number;
  to: number;
  onChange: (from: number, to: number) => void;
}

type DragKind = "from" | "to" | "band";

export function TimeBrush({ schedule, totalDays, from, to, onChange }: Props) {
  const track = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<DragKind | null>(null);

  const span = Math.max(1, totalDays);
  const percent = (days: number) => (Math.min(span, Math.max(0, days)) / span) * 100;
  const windowDays = Math.max(MIN_WINDOW_DAYS, to - from);
  const whole = from <= 0 && to >= span;

  const months = monthTicks(schedule, span);

  const startDrag = (kind: DragKind) => (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const box = track.current?.getBoundingClientRect();
    if (!box) return;

    const startX = event.clientX;
    const startFrom = from;
    const startTo = to;
    setDragging(kind);
    document.body.classList.add("is-brushing");

    const daysFor = (px: number) => (px / box.width) * span;

    const move = (moveEvent: PointerEvent) => {
      const delta = daysFor(moveEvent.clientX - startX);
      if (kind === "band") {
        const length = startTo - startFrom;
        let nextFrom = Math.round(startFrom + delta);
        nextFrom = Math.min(span - length, Math.max(0, nextFrom));
        onChange(nextFrom, nextFrom + length);
        return;
      }
      if (kind === "from") {
        const nextFrom = Math.round(
          Math.min(startTo - MIN_WINDOW_DAYS, Math.max(0, startFrom + delta)),
        );
        onChange(nextFrom, startTo);
        return;
      }
      const nextTo = Math.round(
        Math.max(startFrom + MIN_WINDOW_DAYS, Math.min(span, startTo + delta)),
      );
      onChange(startFrom, nextTo);
    };

    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.classList.remove("is-brushing");
      setDragging(null);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  // клавиатура: окно двигается стрелками, Home/End — к началу и концу проекта
  const onKeyDown = (event: React.KeyboardEvent) => {
    const length = to - from;
    const step = event.shiftKey ? Math.max(1, Math.round(length / 2)) : Math.max(1, Math.round(length / 8));
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      const nextFrom = Math.max(0, from - step);
      onChange(nextFrom, nextFrom + length);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      const nextFrom = Math.min(span - length, from + step);
      onChange(nextFrom, nextFrom + length);
    } else if (event.key === "Home") {
      event.preventDefault();
      onChange(0, length);
    } else if (event.key === "End") {
      event.preventDefault();
      onChange(span - length, span);
    }
  };

  useEffect(() => {
    if (!dragging) return;
    const stop = (event: Event) => event.preventDefault();
    window.addEventListener("selectstart", stop);
    return () => window.removeEventListener("selectstart", stop);
  }, [dragging]);

  return (
    <div className="brush" title="Ручки — масштаб, середина — перемещение по проекту">
      <div className="brush__track" ref={track}>
        {months.map((tick) => (
          <span key={tick.at} className="brush__tick" style={{ left: `${percent(tick.at)}%` }}>
            <i />
            <b>{tick.label}</b>
          </span>
        ))}

        <div
          className={`brush__band${dragging === "band" ? " brush__band--active" : ""}`}
          style={{ left: `${percent(from)}%`, width: `${percent(to) - percent(from)}%` }}
          role="slider"
          tabIndex={0}
          aria-label="Окно просмотра диаграммы"
          aria-valuemin={0}
          aria-valuemax={span}
          aria-valuenow={from}
          onPointerDown={startDrag("band")}
          onKeyDown={onKeyDown}
          onDoubleClick={() => onChange(0, span)}
        >
          <span
            className="brush__handle brush__handle--from"
            onPointerDown={startDrag("from")}
            aria-hidden
          />
          <span
            className="brush__handle brush__handle--to"
            onPointerDown={startDrag("to")}
            aria-hidden
          />
        </div>
      </div>

      <div className="brush__meta">
        <span className="brush__value num">
          {whole ? "весь проект" : `${Math.round(windowDays)} дн.`}
        </span>
        {!whole && (
          <button className="brush__reset" onClick={() => onChange(0, span)}>
            весь проект
          </button>
        )}
      </div>
    </div>
  );
}

/** Метки месяцев на шкале: без них окно висит в пустоте и непонятно, где ты. */
function monthTicks(schedule: Schedule, span: number): { at: number; label: string }[] {
  const start = new Date(`${schedule.project_start}T00:00:00`);
  const ticks: { at: number; label: string }[] = [];
  const cursor = new Date(start);
  cursor.setDate(1);
  // на длинном проекте подписываем не каждый месяц, иначе метки сливаются
  const everyN = span > 730 ? 6 : span > 400 ? 3 : span > 120 ? 2 : 1;
  let index = 0;
  while (true) {
    const offset = Math.round((cursor.getTime() - start.getTime()) / 86400000);
    if (offset > span) break;
    if (offset >= 0 && index % everyN === 0) {
      ticks.push({
        at: offset,
        label: cursor.toLocaleDateString("ru-RU", {
          month: "short",
          year: span > 400 ? "2-digit" : undefined,
        }),
      });
    }
    cursor.setMonth(cursor.getMonth() + 1);
    index += 1;
  }
  return ticks;
}
