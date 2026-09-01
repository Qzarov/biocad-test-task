import { useEffect, useMemo, useRef, useState } from "react";
import { Gantt, ViewMode, type Task as GanttTask } from "gantt-task-react";
import "gantt-task-react/dist/index.css";
import type { ColumnKey, ScheduledTask, Schedule } from "../types";
import { formatDate, formatDateNumeric } from "../format";
import { OPTIONAL_COLUMNS, columnsWidth, gridTemplate } from "./ColumnPicker";

const COLORS = {
  critical: { bar: "#3cb043", progress: "#228B22" },
  normal: { bar: "#5b6172", progress: "#464b59" },
  pinned: { bar: "#f59e0b", progress: "#c27a06" },
  changed: { bar: "#50d1b2", progress: "#2fa78a" },
};

// Высота календаря библиотеки и место под горизонтальный ползунок: без запаса
// ползунок оказывается за границей карточки и мышкой до него не добраться.
const HEADER_HEIGHT = 44;
const SCROLLBAR_SPACE = 26;

interface Props {
  schedule: Schedule;
  viewMode: ViewMode;
  columnWidth: number;
  columns: ColumnKey[];
  changed: string[];
  selectedId: string | null;
  filtered: boolean;
  onSelect: (taskId: string) => void;
  onOpen: (taskId: string) => void;
  onDrag: (taskId: string, start: string, durationDays: number) => void;
  onResetFilters: () => void;
}

export function GanttBoard({
  schedule,
  viewMode,
  columnWidth,
  columns,
  changed,
  selectedId,
  filtered,
  onSelect,
  onOpen,
  onDrag,
  onResetFilters,
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
  const listWidth = `${columnsWidth(columns)}px`;
  const template = gridTemplate(columns);
  const visibleColumns = OPTIONAL_COLUMNS.filter((column) => columns.includes(column.key));

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
            <strong>{filtered ? "Под фильтр ничего не подошло" : "В плане нет задач"}</strong>
            {filtered ? (
              <button className="frox-btn frox-btn-outline frox-btn-sm" onClick={onResetFilters}>
                Сбросить фильтр
              </button>
            ) : (
              <span className="hint">
                Загрузите Excel или попросите агента добавить первую задачу.
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }

  const cellValue = (task: ScheduledTask | undefined, key: ColumnKey) => {
    if (!task) return "—";
    switch (key) {
      case "assignee":
        return task.assignee || "—";
      case "duration":
        return task.duration_days;
      case "start":
        return formatDateNumeric(task.start);
      case "end":
        return formatDateNumeric(task.end);
      case "slack":
        return task.is_critical ? "0" : task.slack_days;
      case "progress":
        return `${task.progress}%`;
    }
  };

  const TaskListHeader = () => (
    <div
      className="gantt-head"
      style={{ width: listWidth, height: HEADER_HEIGHT, gridTemplateColumns: template }}
    >
      <span>Задача</span>
      {visibleColumns.map((column) => (
        <span key={column.key} className="gantt-head__cell">
          {column.label}
        </span>
      ))}
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
    <div style={{ width: listWidth }}>
      {rows.map((row) => {
        const task = byId.get(row.id);
        const classes = ["gantt-row"];
        if (row.id === selectedId) classes.push("gantt-row--selected");
        if (changedSet.has(row.id)) classes.push("gantt-row--changed");
        return (
          <div
            key={row.id}
            className={classes.join(" ")}
            style={{ height: rowHeight, gridTemplateColumns: template }}
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
                className={
                  "gantt-row__flag" +
                  (task?.is_critical
                    ? " gantt-row__flag--critical"
                    : task?.is_pinned
                      ? " gantt-row__flag--pinned"
                      : "")
                }
              />
              <span className="gantt-row__title">{row.name}</span>
            </span>
            {visibleColumns.map((column) => (
              <span
                key={column.key}
                className={`gantt-row__cell${column.key === "assignee" ? "" : " num"}`}
              >
                {cellValue(task, column.key)}
              </span>
            ))}
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
        listCellWidth={listWidth}
        columnWidth={columnWidth}
        rowHeight={40}
        headerHeight={HEADER_HEIGHT}
        barCornerRadius={3}
        barFill={62}
        handleWidth={7}
        arrowColor="#5b5f70"
        arrowIndent={18}
        todayColor="rgba(34, 139, 34, 0.10)"
        fontFamily='"Noto Sans", system-ui, sans-serif'
        fontSize="12.5px"
        ganttHeight={Math.max(200, height - HEADER_HEIGHT - SCROLLBAR_SPACE)}
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
