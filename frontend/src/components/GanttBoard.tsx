import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Gantt, ViewMode, type Task as GanttTask } from "gantt-task-react";
import { GripVertical } from "lucide-react";
import "gantt-task-react/dist/index.css";
import { STATUS_LABELS } from "../types";
import type { ColumnKey, ColumnWidths, ScheduledTask, Schedule } from "../types";
import { formatDate, formatDateNumeric } from "../format";
import {
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  OPTIONAL_COLUMNS,
  columnsWidth,
  gridTemplate,
  widthOf,
} from "./ColumnPicker";
import { ColumnResizer } from "./ColumnResizer";

const COLORS = {
  critical: { bar: "#3cb043", progress: "#228B22" },
  normal: { bar: "#5b6172", progress: "#464b59" },
  pinned: { bar: "#f59e0b", progress: "#c27a06" },
  changed: { bar: "#50d1b2", progress: "#2fa78a" },
  // готовая работа не должна спорить за внимание с тем, что впереди
  done: { bar: "#2f4a35", progress: "#3cb043" },
  blocked: { bar: "#e23738", progress: "#b81f20" },
};

// Высота календаря библиотеки. Место под горизонтальную полосу больше не
// резервируем: полосы нет, по времени ходят шкалой над диаграммой.
const HEADER_HEIGHT = 44;
const SCROLLBAR_SPACE = 2;

interface Props {
  schedule: Schedule;
  viewMode: ViewMode;
  columnWidth: number;
  columns: ColumnKey[];
  columnWidths: ColumnWidths;
  numbers: Record<string, number>;
  /** Спрятать колонку списка совсем (мобильная диаграмма): таймлайн получает всю
   *  ширину, а название задачи рисуется подписью у полоски. */
  hideList?: boolean;
  /** Телефон: жест двигает саму диаграмму в пикселях, а не окно шкалы. Окно
   *  задаёт левый край датой, и библиотека прижимает её к границе колонки —
   *  на неделях это шаг в 64 пикселя, из-за которого прокрутка шла рывками. */
  pixelScroll?: boolean;
  /** Дата у левого края таймлайна — ею управляет шкала над диаграммой.
   *  Прокрутку двигаем именно этим пропом: библиотека держит позицию в своём
   *  состоянии и перебивает прямую запись scrollLeft. */
  viewDate: Date;
  onColumnWidth: (key: ColumnKey | "name", width: number | null) => void;
  /** Ширина видимой части таймлайна: из неё считается масштаб под окно просмотра. */
  onViewport: (width: number) => void;
  /** Замеренная геометрия таймлайна: где в контенте лежит старт проекта и
   *  сколько пикселей приходится на день. Считать это из правил библиотеки
   *  нельзя: она по-разному расширяет диапазон для дня, недели и месяца. */
  onGeometry: (geometry: { originPx: number; pxPerDay: number }) => void;
  /** Фактическая позиция прокрутки таймлайна. Читаем её у самой библиотеки, а не
   *  из окна шкалы: на телефоне жест двигает диаграмму напрямую, и окно шкалы о
   *  этом не знает. */
  onScroll?: (position: { left: number; viewport: number }) => void;
  /** Пиксели на день — из замеренной геометрии; нужны, чтобы перевести
   *  прокрутку колесом в дни. */
  pxPerDay: number;
  /** Горизонтальная прокрутка колесом двигает окно просмотра, а не диаграмму:
   *  иначе диаграмма уезжает мимо шкалы, и следующая перерисовка возвращает её
   *  к окну — со стороны это выглядит как сброс в начало. */
  onPan: (days: number) => void;
  changed: string[];
  selectedId: string | null;
  filtered: boolean;
  onSelect: (taskId: string) => void;
  onOpen: (taskId: string) => void;
  onDrag: (taskId: string, start: string, durationDays: number) => void;
  onReorder: (taskId: string, anchorId: string, position: "before" | "after") => void;
  onResetFilters: () => void;
}

export function GanttBoard({
  schedule,
  viewMode,
  columnWidth,
  columns,
  columnWidths,
  numbers,
  hideList = false,
  pixelScroll = false,
  viewDate,
  onColumnWidth,
  onViewport,
  onGeometry,
  onScroll,
  pxPerDay,
  onPan,
  changed,
  selectedId,
  filtered,
  onSelect,
  onOpen,
  onDrag,
  onReorder,
  onResetFilters,
}: Props) {
  const frame = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(520);

  // Перетаскивание строк меняет только порядок в списке; чтобы это работало и
  // при включённом фильтре, на сервер уходит не номер строки, а «до/после» какой
  // задачи её поставить.
  //
  // Реализация на pointer-событиях, а не на HTML5 drag-and-drop: тянуть можно
  // только за ручку (значит выделение текста и клики по строке не ломаются), и
  // поведение одинаково для мыши, трекпада и тача.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; position: "before" | "after" } | null>(
    null,
  );
  // строка, которую держат пальцем: подсвечиваем ожидание переноса
  const [pressing, setPressing] = useState<string | null>(null);

  // Начать перенос строки. Вызывается из двух мест: ручка слева (мышь) и долгое
  // нажатие на строку (палец) — поведение и результат одинаковые.
  const beginReorder = useCallback(
    (taskId: string) => {
      setDragId(taskId);
      document.body.classList.add("is-dragging-row");

      let hint: { id: string; position: "before" | "after" } | null = null;

      const move = (moveEvent: PointerEvent) => {
        moveEvent.preventDefault();
        const element = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
        const row = element?.closest<HTMLElement>(".gantt-row");
        const overId = row?.dataset.taskId;
        if (!row || !overId || overId === taskId) {
          hint = null;
          setDropHint(null);
          return;
        }
        const box = row.getBoundingClientRect();
        hint = {
          id: overId,
          position: moveEvent.clientY < box.top + box.height / 2 ? "before" : "after",
        };
        setDropHint(hint);
      };

      const finish = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        document.body.classList.remove("is-dragging-row");
        if (hint && hint.id !== taskId) onReorder(taskId, hint.id, hint.position);
        setDragId(null);
        setDropHint(null);
      };

      window.addEventListener("pointermove", move, { passive: false });
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [onReorder],
  );

  const startRowDrag = (taskId: string) => (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    beginReorder(taskId);
  };

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setHeight(Math.max(280, entry.contentRect.height));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Горизонтальную прокрутку библиотека держит в своём контейнере; шкала над
  // диаграммой управляет им напрямую, а обратно мы слушаем скролл, чтобы шкала
  // не отставала, если человек прокрутил колесом или ползунком.
  const scroller = useRef<HTMLElement | null>(null);

  // Жесты навешиваются один раз за жизнь компонента, а свежие колбэки читают из
  // ref: раньше обработчики висели в эффекте с зависимостями, и любая
  // перерисовка (а их много — прокрутка, замер геометрии) снимала слушатели
  // вместе с таймером удержания, из-за чего жест не срабатывал вовсе.
  const panRef = useRef(onPan);
  const pxPerDayRef = useRef(pxPerDay);
  const beginReorderRef = useRef(beginReorder);
  const pixelScrollRef = useRef(pixelScroll);
  const originRef = useRef<number | null>(null);
  const projectDaysRef = useRef(0);

  useEffect(() => {
    panRef.current = onPan;
    pxPerDayRef.current = pxPerDay;
    beginReorderRef.current = beginReorder;
    pixelScrollRef.current = pixelScroll;
    projectDaysRef.current = schedule.project_end
      ? Math.round(
          (new Date(`${schedule.project_end}T00:00:00`).getTime() -
            new Date(`${schedule.project_start}T00:00:00`).getTime()) /
            86400000,
        ) + 1
      : 0;
  }, [onPan, pxPerDay, beginReorder, pixelScroll, schedule]);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;

    // Одно событие scroll ловит все источники прокрутки: шкалу (проп viewDate),
    // колесо, наши жесты — библиотека всё сводит к этому элементу.
    const report = () => {
      const node = scroller.current;
      if (node) onScroll?.({ left: node.scrollLeft, viewport: node.clientWidth });
    };

    // Слушатель навешивается заново при каждом прогоне эффекта: раньше выход по
    // «элемент тот же» случался до подписки, и после первой же перерисовки
    // прокрутка перестала докладывать о себе — бегунок на спайне стоял на месте.
    const attach = () => {
      const found = Array.from(element.querySelectorAll("div")).find(
        (candidate) => getComputedStyle(candidate).overflowX === "auto",
      );
      if (!found) return;
      if (found !== scroller.current) {
        scroller.current = found as HTMLElement;
        onViewport(found.clientWidth);
      }
      found.removeEventListener("scroll", report);
      found.addEventListener("scroll", report, { passive: true });
      report();
    };

    attach();
    const observer = new MutationObserver(attach);
    observer.observe(element, { childList: true, subtree: true });

    const sizes = new ResizeObserver(() => {
      if (scroller.current) onViewport(scroller.current.clientWidth);
      report();
    });
    if (scroller.current) sizes.observe(scroller.current);

    return () => {
      scroller.current?.removeEventListener("scroll", report);
      observer.disconnect();
      sizes.disconnect();
    };
  }, [onViewport, onScroll]);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;

    // Горизонтальное колесо (и Shift+колесо) перехватываем на погружении, до
    // обработчика библиотеки: пусть двигается окно, а диаграмма следует за ним.
    // Свои же синтетические колёса (см. nudge) пропускаем насквозь.
    let synthetic = false;
    const onWheel = (event: WheelEvent) => {
      if (synthetic) return;
      const horizontal = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
      if (!horizontal) return;
      event.preventDefault();
      event.stopPropagation();
      const delta = event.deltaX !== 0 ? event.deltaX : event.deltaY;
      const perDay = pxPerDayRef.current > 0 ? pxPerDayRef.current : 6;
      panRef.current(delta / perDay);
    };
    element.addEventListener("wheel", onWheel, { capture: true, passive: false });

    // Единственный путь, которым библиотека соглашается прокручиваться на
    // произвольное число пикселей, — её собственный обработчик колеса: прямая
    // запись scrollTop/scrollLeft глотается её флагом ignoreScrollEvent, а проп
    // viewDate умеет только целые колонки. Поэтому жест пальца переводим в
    // колесо и отдаём библиотеке — она сама зажимает позицию в границы.
    const nudge = (target: EventTarget | null, deltaX: number, deltaY: number) => {
      const node = (target instanceof Element ? target : null) ?? element.firstElementChild;
      if (!node) return;
      synthetic = true;
      node.dispatchEvent(new WheelEvent("wheel", { deltaX, deltaY, bubbles: true, cancelable: true }));
      synthetic = false;
    };

    // Один автомат на все жесты внутри диаграммы:
    //   • сдвиг в сторону (по полю или по списку задач) — прокрутка по времени;
    //   • сдвиг вверх-вниз — прокрутка строк диаграммы;
    //   • нажатие и удержание на строке — перенос задачи (на телефоне это
    //     единственный способ: свайп там занят прокруткой).
    const LONG_PRESS_MS = 420;
    const AXIS_THRESHOLD = 6;

    let panning = false;
    let axis: "x" | "y" | null = null;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastY = 0;
    let pressTimer = 0;
    let pressedRow: string | null = null;

    const cancelPress = () => {
      if (pressTimer) {
        window.clearTimeout(pressTimer);
        pressTimer = 0;
      }
      pressedRow = null;
      setPressing(null);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      // ручка ширины колонки и ручка переноса — свои жесты
      if (!target || target.closest(".col-resizer") || target.closest(".gantt-row__grip")) return;

      panning = true;
      axis = null;
      startX = lastX = event.clientX;
      startY = lastY = event.clientY;

      const row = target.closest<HTMLElement>(".gantt-row");
      const rowId = row?.dataset.taskId ?? null;
      if (rowId) {
        pressedRow = rowId;
        setPressing(rowId);
        pressTimer = window.setTimeout(() => {
          pressTimer = 0;
          panning = false;
          setPressing(null);
          if (pressedRow) beginReorderRef.current(pressedRow);
          pressedRow = null;
        }, LONG_PRESS_MS);
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!panning) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!axis) {
        if (Math.abs(dx) < AXIS_THRESHOLD && Math.abs(dy) < AXIS_THRESHOLD) return;
        cancelPress();
        axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
        document.body.classList.add("is-panning");
      }
      event.preventDefault();

      if (axis === "y") {
        nudge(event.target, 0, -(event.clientY - lastY));
      } else if (pixelScrollRef.current) {
        // Таймлайн библиотеки продолжается на год после финиша проекта, и без
        // ограничения жест уезжал в пустоту. Дальше последней задачи не пускаем.
        const node = scroller.current;
        let delta = -(event.clientX - lastX);
        const perDay = pxPerDayRef.current;
        if (node && originRef.current !== null && perDay > 0 && projectDaysRef.current > 0) {
          const limit = Math.max(
            0,
            originRef.current + projectDaysRef.current * perDay - node.clientWidth,
          );
          delta = Math.min(limit, Math.max(0, node.scrollLeft + delta)) - node.scrollLeft;
        }
        if (delta) nudge(event.target, delta, 0);
      } else {
        const perDay = pxPerDayRef.current > 0 ? pxPerDayRef.current : 6;
        panRef.current(-(event.clientX - lastX) / perDay);
      }
      lastX = event.clientX;
      lastY = event.clientY;
    };

    const stopPan = () => {
      cancelPress();
      panning = false;
      axis = null;
      document.body.classList.remove("is-panning");
    };

    element.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", stopPan);
    window.addEventListener("pointercancel", stopPan);

    return () => {
      element.removeEventListener("wheel", onWheel, true);
      element.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopPan);
      window.removeEventListener("pointercancel", stopPan);
      stopPan();
    };
    // навешиваем один раз: колбэки берутся из ref, иначе жесты рвутся на
    // каждой перерисовке
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Геометрию снимаем с самих полосок: берём две задачи с разными датами старта
  // и получаем масштаб и точку отсчёта прямо из отрисованного, без догадок о
  // том, как библиотека строит сетку.
  useEffect(() => {
    const node = scroller.current;
    const element = frame.current;
    if (!node || !element || schedule.tasks.length === 0) return;

    const measure = () => {
      const bars = Array.from(element.querySelectorAll(".handleGroup"));
      if (bars.length !== schedule.tasks.length) return;
      const base = node.getBoundingClientRect().left - node.scrollLeft;
      const points = schedule.tasks.map((task, index) => ({
        day: Math.round(
          (new Date(`${task.start}T00:00:00`).getTime() -
            new Date(`${schedule.project_start}T00:00:00`).getTime()) /
            86400000,
        ),
        px: bars[index].getBoundingClientRect().left - base,
      }));
      const first = points[0];
      const other = points.find((point) => point.day !== first.day);
      if (!other) return;
      const pxPerDay = (other.px - first.px) / (other.day - first.day);
      if (!Number.isFinite(pxPerDay) || pxPerDay <= 0) return;
      originRef.current = first.px - first.day * pxPerDay;
      onGeometry({ originPx: originRef.current, pxPerDay });
    };

    const timer = window.setTimeout(measure, 60);
    return () => window.clearTimeout(timer);
  }, [schedule, columnWidth, columns, columnWidths, onGeometry]);



  const byId = useMemo(() => {
    const map = new Map<string, ScheduledTask>();
    schedule.tasks.forEach((task) => map.set(task.id, task));
    return map;
  }, [schedule]);

  const changedSet = useMemo(() => new Set(changed), [changed]);
  const visibleColumns = OPTIONAL_COLUMNS.filter((column) => columns.includes(column.key));

  // Пока границу тянут, ширина живёт здесь: в настройки она уходит на
  // отпускании, иначе каждое движение мыши писало бы в localStorage.
  const [draft, setDraft] = useState<{ key: ColumnKey | "name"; width: number } | null>(null);
  const effectiveWidths: ColumnWidths = draft
    ? { ...columnWidths, [draft.key]: draft.width }
    : columnWidths;
  const listWidth = `${columnsWidth(columns, effectiveWidths)}px`;
  const template = gridTemplate(columns, effectiveWidths);

  const resizer = (key: ColumnKey | "name", label: string) => (
    <ColumnResizer
      width={widthOf(key, effectiveWidths)}
      min={MIN_COLUMN_WIDTH[key]}
      max={MAX_COLUMN_WIDTH}
      label={label}
      onDrag={(width) => setDraft({ key, width })}
      onCommit={(width) => {
        setDraft(null);
        onColumnWidth(key, width);
      }}
      onReset={() => {
        setDraft(null);
        onColumnWidth(key, null);
      }}
    />
  );

  const tasks: GanttTask[] = useMemo(
    () =>
      schedule.tasks.map((task) => {
        const palette = changedSet.has(task.id)
          ? COLORS.changed
          : task.status === "done"
            ? COLORS.done
            : task.status === "blocked"
              ? COLORS.blocked
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
      case "status":
        return STATUS_LABELS[task.status];
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
      <span className="gantt-head__cell">
        Задача
        {resizer("name", "Задача")}
      </span>
      {visibleColumns.map((column) => (
        <span key={column.key} className="gantt-head__cell">
          {column.label}
          {resizer(column.key, column.label)}
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
        if (dragId === row.id) classes.push("gantt-row--dragging");
        if (pressing === row.id) classes.push("gantt-row--pressing");
        if (task?.status === "done") classes.push("gantt-row--done");
        if (task?.status === "blocked") classes.push("gantt-row--blocked");
        if (dropHint?.id === row.id) classes.push(`gantt-row--drop-${dropHint.position}`);
        return (
          <div
            key={row.id}
            className={classes.join(" ")}
            style={{ height: rowHeight, gridTemplateColumns: template }}
            role="button"
            tabIndex={0}
            title={`${row.name} — открыть детали`}
            data-task-id={row.id}
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
              <span className="gantt-row__num num" title="Номер задачи — на него можно ссылаться в чате">
                {numbers[row.id] ?? "—"}
              </span>
              <GripVertical
                className="gantt-row__grip"
                size={14}
                role="button"
                aria-label={`Перетащить «${row.name}»`}
                onPointerDown={startRowDrag(row.id)}
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
              />
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
                className={
                  `gantt-row__cell` +
                  (column.key === "assignee" || column.key === "status" ? "" : " num") +
                  (column.key === "status" ? ` gantt-row__cell--status-${task?.status}` : "")
                }
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
    <div className={`chart__frame${hideList ? " chart__frame--bars-only" : ""}`} ref={frame}>
      <Gantt
        tasks={tasks}
        viewMode={viewMode}
        viewDate={viewDate}
        preStepsCount={1}
        locale="ru-RU"
        listCellWidth={hideList ? "" : listWidth}
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
