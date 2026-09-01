import { useEffect, useRef, useState } from "react";
import type { ColumnKey, ColumnWidths } from "../types";

/** Какие колонки списка задач можно включать. «Задача» не отключается —
 *  без названия строка перестаёт быть строкой. Ширины по умолчанию нужны и для
 *  сетки строки, и для расчёта ширины всей левой части диаграммы; пользователь
 *  может перетащить границу в шапке, и тогда его значение живёт в настройках. */
export const OPTIONAL_COLUMNS: { key: ColumnKey; label: string; width: number }[] = [
  { key: "assignee", label: "Исполнитель", width: 124 },
  { key: "status", label: "Статус", width: 120 },
  { key: "duration", label: "Дн.", width: 48 },
  { key: "start", label: "Начало", width: 96 },
  { key: "end", label: "Окончание", width: 96 },
  { key: "slack", label: "Запас", width: 72 },
  { key: "progress", label: "Прогресс", width: 84 },
];

export const NAME_COLUMN_WIDTH = 236;

/** Границы перетаскивания: слишком узкая колонка перестаёт что-либо показывать,
 *  слишком широкая выдавливает таймлайн за пределы экрана. */
export const MIN_COLUMN_WIDTH: Record<ColumnKey | "name", number> = {
  name: 150,
  assignee: 80,
  status: 92,
  duration: 44,
  start: 78,
  end: 78,
  slack: 56,
  progress: 62,
};

export const MAX_COLUMN_WIDTH = 460;

export function defaultWidth(key: ColumnKey | "name"): number {
  if (key === "name") return NAME_COLUMN_WIDTH;
  return OPTIONAL_COLUMNS.find((column) => column.key === key)?.width ?? 96;
}

export function widthOf(key: ColumnKey | "name", widths: ColumnWidths): number {
  const value = widths[key];
  if (typeof value !== "number") return defaultWidth(key);
  return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH[key], Math.round(value)));
}

export function columnsWidth(columns: ColumnKey[], widths: ColumnWidths): number {
  const optional = OPTIONAL_COLUMNS.filter((column) => columns.includes(column.key));
  const gaps = optional.length * 10;
  const cells = optional.reduce((sum, column) => sum + widthOf(column.key, widths), 0);
  return widthOf("name", widths) + cells + gaps + 28;
}

export function gridTemplate(columns: ColumnKey[], widths: ColumnWidths): string {
  const optional = OPTIONAL_COLUMNS.filter((column) => columns.includes(column.key));
  return [
    `${widthOf("name", widths)}px`,
    ...optional.map((column) => `${widthOf(column.key, widths)}px`),
  ].join(" ");
}

interface Props {
  columns: ColumnKey[];
  hasCustomWidths: boolean;
  onChange: (columns: ColumnKey[]) => void;
  onResetWidths: () => void;
}

export function ColumnPicker({ columns, hasCustomWidths, onChange, onResetWidths }: Props) {
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

          <div className="dropdown__footer">
            <span className="hint">Ширину меняйте перетаскиванием границы в шапке</span>
            {hasCustomWidths && (
              <button
                className="frox-btn frox-btn-outline frox-btn-sm"
                onClick={() => {
                  onResetWidths();
                  setOpen(false);
                }}
              >
                Сбросить ширины
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
