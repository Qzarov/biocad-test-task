import { STATUS_LABELS } from "../types";
import type { ScheduledTask } from "../types";
import { formatDateNumeric, plural } from "../format";

/** Список задач карточками — мобильный вид плана.
 *
 * На телефоне полосы Ганта в 200 пикселей не показывают ни дат, ни зависимостей,
 * а под название остаётся десяток символов. Карточка отдаёт названию всю ширину и
 * выкладывает то, за чем в план и заходят: срок, длительность, исполнителя,
 * статус и запас. Полосы остаются доступны переключателем «Диаграмма».
 */
interface Props {
  tasks: ScheduledTask[];
  numbers: Record<string, number>;
  changed: string[];
  filtered: boolean;
  onOpen: (taskId: string) => void;
  onResetFilters: () => void;
}

export function TaskCards({ tasks, numbers, changed, filtered, onOpen, onResetFilters }: Props) {
  if (tasks.length === 0) {
    return (
      <div className="cards cards--empty">
        <strong>{filtered ? "Под фильтр ничего не подошло" : "В плане нет задач"}</strong>
        {filtered ? (
          <button className="frox-btn frox-btn-outline frox-btn-sm" onClick={onResetFilters}>
            Сбросить фильтр
          </button>
        ) : (
          <span className="hint">Загрузите Excel или попросите агента добавить задачу.</span>
        )}
      </div>
    );
  }

  return (
    <div className="cards">
      {tasks.map((task) => {
        const classes = ["card", `card--${task.status}`];
        if (task.is_critical) classes.push("card--critical");
        if (changed.includes(task.id)) classes.push("card--changed");
        return (
          <div
            key={task.id}
            className={classes.join(" ")}
            role="button"
            tabIndex={0}
            onClick={() => onOpen(task.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen(task.id);
              }
            }}
          >
            <i className="card__stripe" />
            <div className="card__body">
              <div className="card__top">
                <span className="card__num num">{numbers[task.id] ?? "—"}</span>
                <span className="card__name">{task.name}</span>
              </div>

              <div className="card__meta">
                <span className="card__dates num">
                  {formatDateNumeric(task.start)} — {formatDateNumeric(task.end)}
                </span>
                <span className="card__dot">·</span>
                <span>{task.duration_days} дн.</span>
                {task.assignee && (
                  <>
                    <span className="card__dot">·</span>
                    <span>{task.assignee}</span>
                  </>
                )}
              </div>

              <div className="card__meta">
                <span className={`chip chip--status-${task.status}`}>
                  {STATUS_LABELS[task.status]}
                  {task.progress > 0 && task.status !== "done" ? ` · ${task.progress}%` : ""}
                </span>
                {task.is_critical ? (
                  <span className="chip chip--critical">критический путь</span>
                ) : (
                  <span className="chip">
                    запас {plural(task.slack_days, "день", "дня", "дней")}
                  </span>
                )}
                {task.is_pinned && <span className="chip chip--pinned">дата закреплена</span>}
              </div>

              {task.progress > 0 && (
                <div className="card__bar">
                  <span style={{ width: `${task.progress}%` }} />
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
