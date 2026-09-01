import { useEffect, useRef, useState } from "react";
import type { ColumnKey } from "../types";

/** Какие колонки списка задач можно включать. «Задача» не отключается —
 *  без названия строка перестаёт быть строкой. Ширины нужны и для сетки
 *  строки, и для расчёта ширины всей левой части диаграммы. */
export const OPTIONAL_COLUMNS: { key: ColumnKey; label: string; width: number }[] = [
  { key: "assignee", label: "Исполнитель", width: 124 },
  { key: "duration", label: "Дн.", width: 48 },
  { key: "start", label: "Начало", width: 96 },
  { key: "end", label: "Окончание", width: 96 },
  { key: "slack", label: "Запас", width: 72 },
  { key: "progress", label: "Прогресс", width: 84 },
];

export const NAME_COLUMN_WIDTH = 236;

export function columnsWidth(columns: ColumnKey[]): number {
  const optional = OPTIONAL_COLUMNS.filter((column) => columns.includes(column.key));
  const gaps = optional.length * 10;
  return NAME_COLUMN_WIDTH + optional.reduce((sum, column) => sum + column.width, 0) + gaps + 28;
}

export function gridTemplate(columns: ColumnKey[]): string {
  const optional = OPTIONAL_COLUMNS.filter((column) => columns.includes(column.key));
  return ["minmax(0, 1fr)", ...optional.map((column) => `${column.width}px`)].join(" ");
}

interface Props {
  columns: ColumnKey[];
  onChange: (columns: ColumnKey[]) => void;
}

export function ColumnPicker({ columns, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = (key: ColumnKey) =>
    onChange(
      columns.includes(key)
        ? columns.filter((column) => column !== key)
        : OPTIONAL_COLUMNS.filter((column) => column.key === key || columns.includes(column.key)).map(
            (column) => column.key,
          ),
    );

  return (
    <div className="dropdown" ref={box}>
      <button
        className="frox-btn frox-btn-outline frox-btn-sm"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        Колонки
        <span className="dropdown__count num">{columns.length + 1}</span>
      </button>

      {open && (
        <div className="dropdown__menu" role="menu">
          <div className="dropdown__title">Показывать в списке</div>
          <label className="frox-toggle-label dropdown__item dropdown__item--locked">
            <input className="frox-checkbox" type="checkbox" checked disabled />
            <span>Задача</span>
          </label>
          {OPTIONAL_COLUMNS.map((column) => (
            <label key={column.key} className="frox-toggle-label dropdown__item">
              <input
                className="frox-checkbox"
                type="checkbox"
                checked={columns.includes(column.key)}
                onChange={() => toggle(column.key)}
              />
              <span>{column.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
