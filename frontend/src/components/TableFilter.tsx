import { useEffect, useRef, useState } from "react";
import { STATUS_LABELS, STATUS_ORDER } from "../types";
import type { ScheduledTask, TaskFilters } from "../types";

export const EMPTY_FILTERS: TaskFilters = {
  query: "",
  assignee: "",
  status: "",
  criticalOnly: false,
  pinnedOnly: false,
};

export function isFilterActive(filters: TaskFilters): boolean {
  return Boolean(
    filters.query || filters.assignee || filters.status || filters.criticalOnly || filters.pinnedOnly,
  );
}

function activeCount(filters: TaskFilters): number {
  return (
    (filters.assignee ? 1 : 0) +
    (filters.status ? 1 : 0) +
    (filters.criticalOnly ? 1 : 0) +
    (filters.pinnedOnly ? 1 : 0)
  );
}

/** Фильтр применяется к уже рассчитанному расписанию: планировщик всегда считает
 *  весь план, а фильтр только решает, какие строки показать. Иначе скрытая задача
 *  выпала бы из расчёта дат — и диаграмма врала бы. */
export function applyFilters(tasks: ScheduledTask[], filters: TaskFilters): ScheduledTask[] {
  const query = filters.query.trim().toLowerCase();
  return tasks.filter((task) => {
    if (filters.criticalOnly && !task.is_critical) return false;
    if (filters.pinnedOnly && !task.is_pinned) return false;
    if (filters.assignee && task.assignee !== filters.assignee) return false;
    if (filters.status && task.status !== filters.status) return false;
    if (!query) return true;
    return (
      task.name.toLowerCase().includes(query) ||
      task.assignee.toLowerCase().includes(query) ||
      task.id.toLowerCase().includes(query) ||
      task.description.toLowerCase().includes(query)
    );
  });
}

interface Props {
  filters: TaskFilters;
  assignees: string[];
  shown: number;
  total: number;
  onChange: (filters: TaskFilters) => void;
}

/** Компактная панель над списком: поиск виден всегда (им пользуются чаще
 *  всего), остальные условия — в выпадающем меню со счётчиком включённых. */
export function TableFilter({ filters, assignees, shown, total, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const active = isFilterActive(filters);
  const count = activeCount(filters);

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

  return (
    <div className="filters">
      <input
        className="frox-input filters__query"
        type="search"
        value={filters.query}
        placeholder="Поиск"
        onChange={(event) => onChange({ ...filters, query: event.target.value })}
      />

      <div className="dropdown" ref={box}>
        <button
          className="frox-btn frox-btn-outline frox-btn-sm"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          Фильтры
          {count > 0 && <span className="dropdown__count num">{count}</span>}
        </button>

        {open && (
          <div className="dropdown__menu" role="menu">
            <div className="frox-field">
              <span className="dropdown__title">Исполнитель</span>
              <select
                className="frox-select"
                value={filters.assignee}
                onChange={(event) => onChange({ ...filters, assignee: event.target.value })}
              >
                <option value="">любой</option>
                {assignees.map((assignee) => (
                  <option key={assignee} value={assignee}>
                    {assignee}
                  </option>
                ))}
              </select>
            </div>

            <div className="frox-field">
              <span className="dropdown__title">Статус</span>
              <select
                className="frox-select"
                value={filters.status}
                onChange={(event) =>
                  onChange({ ...filters, status: event.target.value as TaskFilters["status"] })
                }
              >
                <option value="">любой</option>
                {STATUS_ORDER.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </div>

            <label className="frox-toggle-label dropdown__item">
              <input
                className="frox-checkbox"
                type="checkbox"
                checked={filters.criticalOnly}
                onChange={(event) => onChange({ ...filters, criticalOnly: event.target.checked })}
              />
              <span>Только критический путь</span>
            </label>

            <label className="frox-toggle-label dropdown__item">
              <input
                className="frox-checkbox"
                type="checkbox"
                checked={filters.pinnedOnly}
                onChange={(event) => onChange({ ...filters, pinnedOnly: event.target.checked })}
              />
              <span>Только с фиксацией даты</span>
            </label>

            {active && (
              <div className="dropdown__footer">
                <button
                  className="frox-btn frox-btn-outline frox-btn-sm"
                  onClick={() => {
                    onChange(EMPTY_FILTERS);
                    setOpen(false);
                  }}
                >
                  Сбросить фильтр
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <span className="filters__count num" title="Показано задач из общего числа">
        {active ? `${shown}/${total}` : total}
      </span>
    </div>
  );
}
