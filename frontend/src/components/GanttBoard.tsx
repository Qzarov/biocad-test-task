import { useEffect, useMemo, useRef, useState } from "react";
import { Gantt, ViewMode, type Task as GanttTask } from "gantt-task-react";
import "gantt-task-react/dist/index.css";
import type { ScheduledTask, Schedule } from "../types";
import { formatDate } from "../format";

const COLORS = {
  normal: { bar: "#0d7d7a", progress: "#0a5f5c" },
  critical: { bar: "#c3145f", progress: "#9a0f4b" },
  pinned: { bar: "#c07f00", progress: "#9a6600" },
  changed: { bar: "#0e1b24", progress: "#0e1b24" },
};

const LIST_WIDTH = "392px";

interface Props {
  schedule: Schedule;
  viewMode: ViewMode;
  changed: string[];
  selectedId: string | null;
  onSelect: (taskId: string) => void;
  onOpen: (taskId: string) => void;
  onDrag: (taskId: string, start: string, durationDays: number) => void;
}

export function GanttBoard({
  schedule,
  viewMode,
  changed,
  selectedId,
  onSelect,
  onOpen,
  onDrag,
}: Props) {
  const frame = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(520);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setHeight(Math.max(280, entry.contentRect.height));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const byId = useMemo(() => {
    const map = new Map<string, ScheduledTask>();
    schedule.tasks.forEach((task) => map.set(task.id, task));
    return map;
  }, [schedule]);

  const changedSet = useMemo(() => new Set(changed), [changed]);

  const tasks: GanttTask[] = useMemo(
    () =>
      schedule.tasks.map((task) => {
        const palette = changedSet.has(task.id)
          ? COLORS.changed
          : task.is_critical
            ? COLORS.critical
            : task.is_pinned
              ? COLORS.pinned
              : COLORS.normal;
        return {
          id: task.id,
          name: task.name,
          type: "task" as const,
          start: new Date(`${task.start}T00:00:00`),
          // the library treats `end` as exclusive-ish, so push it to the day's end
          end: new Date(`${task.end}T23:59:00`),
          progress: task.progress,
          dependencies: task.predecessors,
          styles: {
            backgroundColor: palette.bar,
            backgroundSelectedColor: palette.progress,
            progressColor: palette.progress,
            progressSelectedColor: palette.progress,
          },
        };
      }),
    [schedule, changedSet],
  );

  if (!tasks.length) {
    return (
      <div className="chart__frame">
        <div className="chart__empty">
          <div>
            <p style={{ margin: "0 0 6px", fontWeight: 600 }}>В плане нет задач</p>
            <p style={{ margin: 0 }}>Загрузите Excel или попросите агента добавить первую задачу.</p>
          </div>
        </div>
      </div>
    );
  }

  const TaskListHeader = () => (
    <div className="gantt-head" style={{ width: LIST_WIDTH, height: 44 }}>
      <span className="label">Задача</span>
      <span className="label">Исполнитель</span>
      <span className="label">Дн.</span>
    </div>
  );

  const TaskListTable = ({
    tasks: rows,
    rowHeight,
  }: {
    tasks: GanttTask[];
    rowHeight: number;
    rowWidth: string;
    fontFamily: string;
    fontSize: string;
    locale: string;
    selectedTaskId: string;
    setSelectedTask: (taskId: string) => void;
    onExpanderClick: (task: GanttTask) => void;
  }) => (
    <div style={{ width: LIST_WIDTH }}>
      {rows.map((row) => {
        const task = byId.get(row.id);
        const classes = ["gantt-row"];
        if (row.id === selectedId) classes.push("gantt-row--selected");
        if (changedSet.has(row.id)) classes.push("gantt-row--changed");
        return (
          <div
            key={row.id}
            className={classes.join(" ")}
            style={{ height: rowHeight }}
            role="button"
            tabIndex={0}
            title={`${row.name} — открыть детали`}
            onClick={() => onSelect(row.id)}
            onDoubleClick={() => onOpen(row.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen(row.id);
              }
            }}
          >
            <span className="gantt-row__name">
              <i
                className={`gantt-row__flag${task?.is_critical ? " gantt-row__flag--critical" : ""}`}
                style={task?.is_pinned && !task?.is_critical ? { background: "var(--amber)" } : undefined}
              />
              <span className="gantt-row__title">{row.name}</span>
            </span>
            <span className="gantt-row__assignee">{task?.assignee || "—"}</span>
            <span className="gantt-row__days mono">{task?.duration_days ?? "—"}</span>
          </div>
        );
      })}
    </div>
  );

  const TooltipContent = ({ task: row }: { task: GanttTask }) => {
    const task = byId.get(row.id);
    if (!task) return null;
    return (
      <div className="gantt-tooltip">
        <div className="gantt-tooltip__name">{task.name}</div>
        <dl className="gantt-tooltip__grid">
          <dt>Срок</dt>
          <dd>
            {formatDate(task.start)} — {formatDate(task.end)}
          </dd>
          <dt>Длительность</dt>
          <dd>{task.duration_days} дн.</dd>
          <dt>Исполнитель</dt>
          <dd>{task.assignee || "—"}</dd>
          <dt>Запас</dt>
          <dd>{task.is_critical ? "нет, критический путь" : `${task.slack_days} дн.`}</dd>
          {task.is_pinned && (
            <>
              <dt>Фиксация</dt>
              <dd>дата закреплена вручную</dd>
            </>
          )}
        </dl>
      </div>
    );
  };

  return (
    <div className="chart__frame" ref={frame}>
      <Gantt
        tasks={tasks}
        viewMode={viewMode}
        viewDate={new Date(`${schedule.project_start}T00:00:00`)}
        preStepsCount={1}
        locale="ru-RU"
        listCellWidth={LIST_WIDTH}
        columnWidth={viewMode === ViewMode.Month ? 120 : viewMode === ViewMode.Week ? 74 : 42}
        rowHeight={40}
        headerHeight={44}
        barCornerRadius={2}
        barFill={62}
        handleWidth={7}
        arrowColor="#8ba3af"
        arrowIndent={18}
        todayColor="rgba(13, 125, 122, 0.09)"
        fontFamily='"IBM Plex Sans", system-ui, sans-serif'
        fontSize="12.5px"
        ganttHeight={Math.max(240, height - 44)}
        TaskListHeader={TaskListHeader}
        TaskListTable={TaskListTable}
        TooltipContent={TooltipContent}
        onClick={(row) => onSelect(row.id)}
        onDoubleClick={(row) => onOpen(row.id)}
        onDateChange={(row) => {
          const start = row.start;
          const isoStart = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(
            start.getDate(),
          ).padStart(2, "0")}`;
          const days = Math.max(
            1,
            Math.round((row.end.getTime() - row.start.getTime()) / 86400000) || 1,
          );
          onDrag(row.id, isoStart, days);
        }}
      />
    </div>
  );
}
