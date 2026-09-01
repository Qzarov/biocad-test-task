import type { ScheduledTask, TaskFilters } from "../types";

export const EMPTY_FILTERS: TaskFilters = {
  query: "",
  assignee: "",
  criticalOnly: false,
  pinnedOnly: false,
};

export function isFilterActive(filters: TaskFilters): boolean {
  return Boolean(filters.query || filters.assignee || filters.criticalOnly || filters.pinnedOnly);
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

export function TableFilter({ filters, assignees, shown, total, onChange }: Props) {
  const active = isFilterActive(filters);

  return (
    <div className="filters">
      <input
        className="frox-input filters__query"
        type="search"
        value={filters.query}
        placeholder="Поиск по задачам"
        onChange={(event) => onChange({ ...filters, query: event.target.value })}
      />

      <select
        className="frox-select filters__assignee"
        value={filters.assignee}
        onChange={(event) => onChange({ ...filters, assignee: event.target.value })}
      >
        <option value="">Все исполнители</option>
        {assignees.map((assignee) => (
          <option key={assignee} value={assignee}>
            {assignee}
          </option>
        ))}
      </select>

      <label className="frox-toggle-label filters__toggle">
        <input
          className="frox-checkbox"
          type="checkbox"
          checked={filters.criticalOnly}
          onChange={(event) => onChange({ ...filters, criticalOnly: event.target.checked })}
        />
        <span>Критический путь</span>
      </label>

      <label className="frox-toggle-label filters__toggle">
        <input
          className="frox-checkbox"
          type="checkbox"
          checked={filters.pinnedOnly}
          onChange={(event) => onChange({ ...filters, pinnedOnly: event.target.checked })}
        />
        <span>С фиксацией даты</span>
      </label>

      <span className="filters__count">
        {active ? `показано ${shown} из ${total}` : `задач: ${total}`}
      </span>

      {active && (
        <button
          className="frox-btn frox-btn-outline frox-btn-sm"
          onClick={() => onChange(EMPTY_FILTERS)}
        >
          Сбросить
        </button>
      )}
    </div>
  );
}
