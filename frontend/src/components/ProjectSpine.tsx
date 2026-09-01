import type { Schedule } from "../types";

/** The project spine: every task drawn once on a shared time axis.
 *
 * It answers three questions at a glance that the chart below needs scrolling
 * for — how long the project runs, where the work piles up, and how much of it
 * sits on the critical path. Lanes are filled round-robin, so density is real
 * information: a crowded stretch is a crowded month. */
export function ProjectSpine({ schedule }: { schedule: Schedule }) {
  const start = new Date(schedule.project_start).getTime();
  const end = schedule.project_end ? new Date(schedule.project_end).getTime() : start;
  const span = Math.max(end - start, 86400000);
  const LANES = 4;
  const laneHeight = 4;
  const laneGap = 2;
  const width = 1000;
  const height = LANES * (laneHeight + laneGap);

  const x = (iso: string) => ((new Date(iso).getTime() - start) / span) * width;
  const today = ((Date.now() - start) / span) * width;

  const months: { at: number; label: string }[] = [];
  const cursor = new Date(schedule.project_start);
  cursor.setDate(1);
  while (cursor.getTime() <= end) {
    if (cursor.getTime() >= start) {
      months.push({
        at: ((cursor.getTime() - start) / span) * width,
        label: cursor.toLocaleDateString("ru-RU", { month: "short" }),
      });
    }
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return (
    <div className="spine">
      <span className="label">Спайн проекта</span>
      <div className="spine__scale">
        <svg
          className="spine__svg"
          viewBox={`0 0 ${width} ${height + 10}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="Плотность задач по времени проекта"
        >
          {months.map((month) => (
            <line
              key={month.label + month.at}
              x1={month.at}
              x2={month.at}
              y1={0}
              y2={height}
              stroke="var(--border)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {schedule.tasks.map((task, index) => {
            const left = x(task.start);
            const right = Math.max(x(task.end), left + 1.5);
            const lane = index % LANES;
            return (
              <rect
                key={task.id}
                x={left}
                y={lane * (laneHeight + laneGap)}
                width={right - left}
                height={laneHeight}
                rx={1}
                fill={
                  task.is_critical
                    ? "var(--plan-critical)"
                    : task.is_pinned
                      ? "var(--plan-pinned)"
                      : "var(--plan-normal)"
                }
                opacity={task.is_critical ? 1 : 0.85}
              />
            );
          })}

          {today >= 0 && today <= width && (
            <line
              x1={today}
              x2={today}
              y1={-2}
              y2={height + 3}
              stroke="var(--text-primary)"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
      </div>
      <div className="spine__legend">
        <span
          className="legend-item"
          title="Задачи без запаса: сдвиньте любую на день — на день уедет и весь проект"
        >
          <i className="legend-swatch" style={{ background: "var(--plan-critical)" }} /> критический
          путь
        </span>
        <span
          className="legend-item"
          title="У задачи есть свободные дни: её можно сдвинуть или растянуть, срок проекта не изменится"
        >
          <i className="legend-swatch" style={{ background: "var(--plan-normal)" }} /> с запасом
        </span>
        <span
          className="legend-item"
          title="Дата старта задана вручную («не раньше»), а не выведена из зависимостей; зависимости всё равно сильнее"
        >
          <i className="legend-swatch" style={{ background: "var(--plan-pinned)" }} /> дата
          закреплена
        </span>
      </div>
    </div>
  );
}
