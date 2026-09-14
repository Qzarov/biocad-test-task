import { useEffect, useRef, useState } from "react";

/** Длинный текст в чате сворачивается до нескольких строк.
 *
 * Кнопка появляется только если текст действительно не уместился: измеряем
 * фактическую высоту после отрисовки, а не считаем символы — при переносах и
 * разной ширине панели «сколько строк» иначе не угадать.
 */
interface Props {
  text: string;
  lines?: number;
  className?: string;
}

export function Collapsible({ text, lines = 4, className }: Props) {
  const body = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const element = body.current;
    if (!element) return;
    const measure = () => {
      const wasOpen = element.classList.contains("clamp--open");
      if (wasOpen) element.classList.remove("clamp--open");
      setClipped(element.scrollHeight - element.clientHeight > 2);
      if (wasOpen) element.classList.add("clamp--open");
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, lines]);

  return (
    <div className={className}>
      <div
        ref={body}
        className={`clamp${open ? " clamp--open" : ""}`}
        style={{ ["--clamp-lines" as string]: String(lines) }}
      >
        {text}
      </div>
      {clipped && (
        <button className="clamp__toggle" onClick={() => setOpen((value) => !value)}>
          {open ? "Свернуть" : "Развернуть"}
        </button>
      )}
    </div>
  );
}
