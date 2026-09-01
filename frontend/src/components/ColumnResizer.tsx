import { useRef } from "react";

/** Ручка изменения ширины колонки: сидит в зазоре между колонками шапки.
 *
 * Во время перетаскивания ширина живёт в состоянии диаграммы (`onDrag`), а в
 * настройки уходит один раз на отпускании (`onCommit`) — иначе каждое движение
 * мыши писало бы в localStorage.
 *
 * Двойной клик возвращает ширину по умолчанию, стрелками можно двигать границу
 * с клавиатуры: ручка шириной 8px — не то, во что попадёт каждый.
 */
interface Props {
  width: number;
  min: number;
  max: number;
  label: string;
  onDrag: (width: number) => void;
  onCommit: (width: number) => void;
  onReset: () => void;
}

export function ColumnResizer({ width, min, max, label, onDrag, onCommit, onReset }: Props) {
  const startX = useRef(0);
  const startWidth = useRef(width);

  const clamp = (value: number) => Math.min(max, Math.max(min, Math.round(value)));

  const onPointerDown = (event: React.PointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    startX.current = event.clientX;
    startWidth.current = width;
    document.body.classList.add("is-resizing");

    const move = (moveEvent: PointerEvent) => {
      onDrag(clamp(startWidth.current + (moveEvent.clientX - startX.current)));
    };
    const up = (upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      document.body.classList.remove("is-resizing");
      onCommit(clamp(startWidth.current + (upEvent.clientX - startX.current)));
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  return (
    <span
      className="col-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={`Ширина колонки «${label}»`}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="Потяните, чтобы изменить ширину. Двойной клик — вернуть по умолчанию"
      onPointerDown={onPointerDown}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onReset();
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 24 : 8;
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          onCommit(clamp(width - step));
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          onCommit(clamp(width + step));
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onReset();
        }
      }}
    />
  );
}
