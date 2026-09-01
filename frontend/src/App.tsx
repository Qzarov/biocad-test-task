import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ViewMode } from "gantt-task-react";
import {
  Bot,
  Download,
  FileDown,
  FileSpreadsheet,
  Redo2,
  TriangleAlert,
  Undo2,
  Upload,
} from "lucide-react";
import { ApiError, api, sessionId, streamChat } from "./api";
import { ChatPanel } from "./components/ChatPanel";
import { ColumnPicker, columnsWidth } from "./components/ColumnPicker";
import { GanttBoard } from "./components/GanttBoard";
import { ProjectSpine } from "./components/ProjectSpine";
import { EMPTY_FILTERS, TableFilter, applyFilters, isFilterActive } from "./components/TableFilter";
import { TaskCards } from "./components/TaskCards";
import { TaskModal } from "./components/TaskModal";
import { MIN_WINDOW_DAYS, TimeBrush } from "./components/TimeBrush";
import { Toasts, type Toast } from "./components/Toasts";
import { daysBetween, formatDateNumeric, plural } from "./format";
import { loadPrefs, savePrefs } from "./prefs";
import type {
  ChatEntry,
  ColumnKey,
  Health,
  Mention,
  ModelInfo,
  PlanPayload,
  TaskFilters,
} from "./types";

/** Шаг таймлайна выводится из ширины окна просмотра: зазумившись на неделю,
 *  бессмысленно видеть в шапке месяцы, а на годовом проекте — дни. */
function stepFor(windowDays: number): ViewMode {
  if (windowDays <= 45) return ViewMode.Day;
  if (windowDays <= 240) return ViewMode.Week;
  return ViewMode.Month;
}

// Сколько дней приходится на колонку таймлайна — из этого считается ширина
// колонки под окно просмотра. Позицию задаёт проп viewDate самой библиотеки.
const DAYS_PER_COLUMN: Partial<Record<ViewMode, number>> = {
  [ViewMode.Day]: 1,
  [ViewMode.Week]: 7,
  [ViewMode.Month]: 30.44,
};

/** Мобильный вид: фиксированный масштаб вместо окна просмотра. На экране в
 *  230 пикселей таймлайна окно всё равно упиралось в минимальную ширину колонки,
 *  и ползунок перестал что-либо менять — честнее дать три понятных шага. */
const MOBILE_STEPS: { key: "day" | "week" | "month"; mode: ViewMode; label: string; column: number }[] = [
  { key: "day", mode: ViewMode.Day, label: "Дни", column: 40 },
  { key: "week", mode: ViewMode.Week, label: "Недели", column: 64 },
  { key: "month", mode: ViewMode.Month, label: "Месяцы", column: 104 },
];

const STEP_LABELS: Partial<Record<ViewMode, string>> = {
  [ViewMode.Day]: "дни",
  [ViewMode.Week]: "недели",
  [ViewMode.Month]: "месяцы",
};

/** Окно просмотра: смещение в днях от старта проекта и его длина.
 *  `days: null` — «весь проект», чтобы окно не ломалось при замене плана. */
interface ViewWindow {
  from: number;
  days: number | null;
}

export default function App() {
  const [payload, setPayload] = useState<PlanPayload | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [view, setView] = useState<ViewWindow>(() => ({ from: 0, days: loadPrefs().windowDays }));
  const [viewport, setViewport] = useState(900);
  const [geometry, setGeometry] = useState({ originPx: 0, pxPerDay: 0 });
  const [scroll, setScroll] = useState({ left: 0, viewport: 0 });
  // На узком экране список в полную ширину выдавливает таймлайн за край: двигать
  // диаграмму становится нечем. Поэтому там остаётся только колонка с названием,
  // и та ограничена по ширине; настройки колонок при этом не теряются.
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 700px)").matches,
  );

  useEffect(() => {
    const query = window.matchMedia("(max-width: 700px)");
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [changed, setChanged] = useState<string[]>([]);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [prefs, setPrefs] = useState(loadPrefs);
  const [filters, setFilters] = useState<TaskFilters>(EMPTY_FILTERS);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  // На телефоне чат по умолчанию свёрнут: развёрнутый он забирает половину
  // экрана у диаграммы, а открыть его — одно нажатие.
  const [chatExpanded, setChatExpanded] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 700px)").matches,
  );
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const fileInput = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const highlightTimer = useRef<number | null>(null);
  // Прокрутка диаграммы бывает двух видов: наша (окно шкалы двигает viewDate) и
  // пользовательская (ползунок под диаграммой, колесо). Различить их по событию
  // нельзя, поэтому после своей правки окна короткое время не слушаем скролл —
  // иначе догоняющее событие возвращало окно назад, и перетаскивание середины
  // «отскакивало» на отпускании.
  const ignoreScrollUntil = useRef(0);

  const pushToast = useCallback((toast: Omit<Toast, "id">) => {
    setToasts((current) => [...current.slice(-3), { ...toast, id: Date.now() + Math.random() }]);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const fail = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError) {
        pushToast({ kind: "error", message: error.message, details: error.details });
      } else {
        pushToast({ kind: "error", message: String(error) });
      }
    },
    [pushToast],
  );

  const highlight = useCallback((ids: string[]) => {
    setChanged(ids);
    if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
    highlightTimer.current = window.setTimeout(() => setChanged([]), 7000);
  }, []);

  const run = useCallback(
    async (action: () => Promise<PlanPayload>, options: { highlight?: boolean } = {}) => {
      setBusy(true);
      try {
        const next = await action();
        setPayload(next);
        if (options.highlight !== false) highlight(next.changed ?? []);
        if (next.message) pushToast({ kind: "info", message: next.message });
        return next;
      } catch (error) {
        fail(error);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [fail, highlight, pushToast],
  );

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
    api
      .models()
      .then((response) => {
        setModels(response.models);
        setPrefs((current) =>
          current.model && response.models.some((model) => model.id === current.model)
            ? current
            : { ...current, model: response.default },
        );
      })
      .catch(() => setModels([]));
    run(() => api.plan(), { highlight: false });

    // переписка живёт на сервере, поэтому после перезагрузки страницы её нужно
    // просто забрать: id ходов генерируем локально, они нужны только React
    api
      .chatHistory()
      .then((history) =>
        setEntries(
          history.entries.map((entry, index) => ({
            id: `history-${index}`,
            role: entry.role,
            text: entry.text,
            tools: entry.tools,
          })),
        ),
      )
      .catch(() => undefined)
      .finally(() => setLoadingHistory(false));
  }, [run]);

  useEffect(() => {
    savePrefs(prefs);
  }, [prefs]);



  const plan = payload?.plan;
  const schedule = payload?.schedule;

  const openTask = useMemo(
    () => plan?.tasks.find((task) => task.id === openTaskId) ?? null,
    [plan, openTaskId],
  );
  const openComputed = useMemo(
    () => schedule?.tasks.find((task) => task.id === openTaskId) ?? null,
    [schedule, openTaskId],
  );
  const successors = useMemo(
    () => plan?.tasks.filter((task) => task.predecessors.includes(openTaskId ?? "")) ?? [],
    [plan, openTaskId],
  );

  const visibleTasks = useMemo(
    () => applyFilters(schedule?.tasks ?? [], filters),
    [schedule, filters],
  );
  const visibleSchedule = useMemo(
    () => (schedule ? { ...schedule, tasks: visibleTasks } : null),
    [schedule, visibleTasks],
  );
  const assigneeOptions = useMemo(
    () =>
      Array.from(new Set((plan?.tasks ?? []).map((task) => task.assignee).filter(Boolean))).sort(
        (a, b) => a.localeCompare(b, "ru"),
      ),
    [plan],
  );
  const criticalCount = schedule?.tasks.filter((task) => task.is_critical).length ?? 0;
  const assignees = new Set((plan?.tasks ?? []).map((task) => task.assignee).filter(Boolean));
  const totalDays =
    schedule?.project_end ? daysBetween(schedule.project_start, schedule.project_end) : 0;

  // Из окна просмотра выводится всё: шаг таймлайна, ширина колонки и позиция
  // прокрутки. Одна величина вместо трёх независимых контролов.
  const windowDays = Math.min(
    Math.max(MIN_WINDOW_DAYS, view.days ?? (totalDays || MIN_WINDOW_DAYS)),
    Math.max(MIN_WINDOW_DAYS, totalDays || MIN_WINDOW_DAYS),
  );
  const windowTo = Math.min(totalDays, view.from + windowDays);
  const mobile = MOBILE_STEPS.find((step) => step.key === prefs.mobileStep) ?? MOBILE_STEPS[1];
  const viewMode = narrow ? mobile.mode : stepFor(windowDays);
  const desktopColumnWidth = Math.round(
    Math.min(
      420,
      Math.max(
        // ниже ~22px подписи календаря в шапке библиотеки сливаются в кашу
        22,
        // +1 колонка — библиотека рисует одну до старта проекта (preStepsCount)
        viewport / Math.max(1, windowDays / (DAYS_PER_COLUMN[viewMode] ?? 7) + 1),
      ),
    ),
  );
  const columnWidth = narrow ? mobile.column : desktopColumnWidth;
  const daysPerColumn = DAYS_PER_COLUMN[viewMode] ?? 7;

  // Сколько дней реально видно: на большом экране это окно шкалы, на мобиле —
  // сколько влезло при выбранном шаге. Именно этой величиной ограничивается
  // позиция прокрутки: раньше на мобиле она обрезалась длиной «настольного»
  // окна (весь проект), поэтому смещение всегда сбрасывалось в ноль и свайп
  // ничего не двигал.
  const visibleDays = narrow
    ? Math.max(1, (viewport / Math.max(1, columnWidth)) * daysPerColumn)
    : windowDays;
  const windowFrom = Math.min(Math.max(0, view.from), Math.max(0, totalDays - visibleDays));
  // Левый край таймлайна — дата начала окна. Прокруткой занимается сама
  // библиотека (проп viewDate): она знает свою сетку, а прямую запись scrollLeft
  // перебивает собственным состоянием.
  const viewDateTime = schedule
    ? new Date(`${schedule.project_start}T00:00:00`).getTime() + windowFrom * 86400000
    : 0;
  const viewDate = useMemo(() => new Date(viewDateTime), [viewDateTime]);
  const pxPerDay = geometry.pxPerDay > 0 ? geometry.pxPerDay : columnWidth / daysPerColumn;

  // Видимая часть плана для бегунка на спайне: считаем из фактической прокрутки
  // таймлайна, а не из окна шкалы — на телефоне жест двигает диаграмму напрямую.
  const visibleWindow =
    geometry.pxPerDay > 0 && scroll.viewport > 0
      ? {
          from: (scroll.left - geometry.originPx) / geometry.pxPerDay,
          days: scroll.viewport / geometry.pxPerDay,
        }
      : null;

  // Колесо двигает окно просмотра: при «всём проекте» двигать некуда, и вид
  // просто стоит на месте — раньше диаграмма уезжала в пустой хвост таймлайна.
  const panDays = useCallback(
    (days: number) => {
      if (!Number.isFinite(days) || Math.abs(days) < 0.01) return;
      setView((current) => {
        const length = narrow ? visibleDays : current.days ?? totalDays;
        const limit = Math.max(0, totalDays - length);
        if (limit === 0) return current;
        const next = Math.min(limit, Math.max(0, current.from + days));
        return Math.round(next) === Math.round(current.from) ? current : { ...current, from: next };
      });
    },
    [totalDays, narrow, visibleDays],
  );
  // На телефоне в режиме диаграммы колонки списка скрываются совсем: 200 пикселей
  // названий отнимали место у полос, а имя видно над полоской и в карточке.
  const visibleColumns = narrow ? [] : prefs.columns;
  const visibleWidths = narrow
    ? { ...prefs.columnWidths, name: Math.min(168, prefs.columnWidths.name ?? 236) }
    : prefs.columnWidths;
  const listWidth = columnsWidth(visibleColumns, visibleWidths);

  // Кнопки отмены и возврата ходят по той же истории снимков, что и агент:
  // текущее состояние помечено is_current, всё до него — отмена, после — возврат.
  const historyIndex = payload?.history?.findIndex((item) => item.is_current) ?? -1;
  const canUndo = historyIndex > 0;
  const canRedo = historyIndex >= 0 && historyIndex < (payload?.history?.length ?? 0) - 1;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
      const target = event.target as HTMLElement | null;
      // в полях ввода Ctrl+Z должен отменять текст, а не правку плана
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      event.preventDefault();
      if (event.shiftKey) {
        if (canRedo) run(() => api.redo(), { highlight: false });
      } else if (canUndo) {
        run(() => api.undo(), { highlight: false });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canUndo, canRedo, run]);

  const setWindow = useCallback(
    (from: number, to: number) => {
      ignoreScrollUntil.current = Date.now() + 600;
      setView({
        from: Math.max(0, Math.round(from)),
        days: to - from >= totalDays ? null : Math.round(to - from),
      });
      setPrefs((current) => ({
        ...current,
        windowDays: to - from >= totalDays ? null : Math.round(to - from),
      }));
    },
    [totalDays, narrow, visibleDays],
  );

  // Номер задачи — её позиция в плане (не в отфильтрованном списке): именно этот
  // номер видит пользователь и понимает бэкенд.
  const taskNumbers = useMemo(() => {
    const map: Record<string, number> = {};
    (plan?.tasks ?? []).forEach((task, index) => {
      map[task.id] = index + 1;
    });
    return map;
  }, [plan]);

  const mentions = useMemo<Mention[]>(
    () => [
      ...(plan?.tasks ?? []).map((task, index) => ({
        kind: "task" as const,
        label: task.name,
        hint: task.assignee ? `задача · ${task.assignee}` : "задача",
        // В текст вставляется название, а не номер: номер — это позиция, и после
        // перетаскивания задач он в уже набранном сообщении указывал бы на другую
        // задачу. Номер остаётся в меню (по нему удобно искать) и в ручном вводе
        // «#5», который разбирается в момент отправки.
        insert: `«${task.name}»`,
        number: index + 1,
      })),
      ...assigneeOptions.map((assignee) => ({
        kind: "person" as const,
        label: assignee,
        hint: "исполнитель",
        insert: `@${assignee}`,
      })),
    ],
    [plan, assigneeOptions],
  );


  const sendMessage = useCallback(
    async (message: string) => {
      const turnId = `turn-${Date.now()}`;
      setEntries((current) => [
        ...current,
        { id: `${turnId}-user`, role: "user", text: message },
        { id: turnId, role: "agent", text: "", tools: [], pending: true },
      ]);
      setStreaming(true);
      setChatCollapsed(false);
      abort.current = new AbortController();

      const patch = (update: (entry: ChatEntry) => ChatEntry) =>
        setEntries((current) => current.map((entry) => (entry.id === turnId ? update(entry) : entry)));

      try {
        await streamChat(
          message,
          (event) => {
            switch (event.type) {
              case "tool_call":
                patch((entry) => ({
                  ...entry,
                  tools: [...(entry.tools ?? []), { name: event.name, args: event.arguments }],
                }));
                break;
              case "tool_result":
                patch((entry) => {
                  const tools = [...(entry.tools ?? [])];
                  for (let i = tools.length - 1; i >= 0; i -= 1) {
                    if (tools[i].name === event.name && tools[i].result === undefined) {
                      tools[i] = { ...tools[i], result: event.text, ok: event.ok };
                      break;
                    }
                  }
                  return { ...entry, tools };
                });
                break;
              case "message":
                patch((entry) => ({
                  ...entry,
                  text: entry.text ? `${entry.text}\n\n${event.text}` : event.text,
                  pending: !event.final,
                }));
                break;
              case "plan":
                setPayload((current) =>
                  current
                    ? { ...current, plan: event.plan, schedule: event.schedule, changed: event.changed }
                    : current,
                );
                highlight(event.changed);
                break;
              case "error":
                setEntries((current) => [
                  ...current.map((entry) => (entry.id === turnId ? { ...entry, pending: false } : entry)),
                  { id: `${turnId}-error`, role: "error", text: event.text },
                ]);
                break;
              case "done":
                patch((entry) => ({ ...entry, pending: false }));
                break;
            }
          },
          { signal: abort.current.signal, model: prefs.model ?? undefined },
        );
        // resync history so undo reflects what the agent did
        const fresh = await api.plan();
        setPayload((current) => ({ ...fresh, changed: current?.changed ?? [] }));
      } catch (error) {
        if ((error as Error)?.name === "AbortError") {
          patch((entry) => ({ ...entry, pending: false, text: entry.text || "Остановлено." }));
        } else {
          fail(error);
          patch((entry) => ({ ...entry, pending: false }));
        }
      } finally {
        setStreaming(false);
        abort.current = null;
      }
    },
    [fail, highlight, prefs.model],
  );

  return (
    <div className="app">
      <header className="masthead">
        <div className="masthead__identity">
          <h1 title={`сессия ${sessionId()}`}>{plan?.title ?? "План проекта"}</h1>
          <div className="stats">
            <label className="stats__item">
              <span className="stats__label">старт</span>
              <input
                className="stats__date"
                type="date"
                value={schedule?.project_start ?? ""}
                onChange={(event) =>
                  event.target.value && run(() => api.setProjectStart(event.target.value))
                }
                disabled={busy || streaming}
              />
            </label>
            <span className="stats__item">
              <span className="stats__label">финиш</span>
              <b className="num">{formatDateNumeric(schedule?.project_end)}</b>
            </span>
            <span className="stats__item">
              <b className="num">{totalDays || "—"}</b>
              <span className="stats__label">дн.</span>
            </span>
            <span className="stats__item">
              <b className="num">{plan?.tasks.length ?? 0}</b>
              <span className="stats__label">задач</span>
            </span>
            <span className="stats__item" title="Задачи без запаса: сдвинь любую — уедет весь проект">
              <b className="num stats__critical">{criticalCount}</b>
              <span className="stats__label">крит.</span>
            </span>
            <span className="stats__item">
              <b className="num">{assignees.size}</b>
              <span className="stats__label">исп.</span>
            </span>
            <span
              className="stats__item stats__source"
              title={plan?.source ? `План загружен из файла ${plan.source}` : "Демо-план из шаблона"}
            >
              <FileSpreadsheet size={13} />
              <span>{plan?.source || "демо-план"}</span>
            </span>
            {schedule?.warnings && schedule.warnings.length > 0 && (
              <span
                className="stats__item stats__warning"
                title={schedule.warnings.join("\n")}
              >
                <TriangleAlert size={13} />
                <span>{plural(schedule.warnings.length, "замечание", "замечания", "замечаний")}</span>
              </span>
            )}
          </div>
        </div>

        <div className="actions">
          <input
            ref={fileInput}
            type="file"
            accept=".xlsx"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) {
                setEntries([]);
                run(() => api.importXlsx(file), { highlight: false });
              }
            }}
          />
          <button
            className="frox-btn frox-btn-outline"
            onClick={() => fileInput.current?.click()}
            disabled={busy}
            title="Загрузить план из Excel"
          >
            <Upload size={14} />
            <span className="btn__label">Загрузить</span>
          </button>
          <a
            className="frox-btn frox-btn-brand"
            href={api.exportUrl()}
            title="Скачать текущий план в Excel"
          >
            <Download size={14} />
            <span className="btn__label">Скачать</span>
          </a>
          <span className="undo-pair">
            <button
              className="icon-btn"
              onClick={() => run(() => api.undo(), { highlight: false })}
              disabled={busy || streaming || !canUndo}
              title="Отменить последнюю правку (Ctrl+Z)"
              aria-label="Отменить"
            >
              <Undo2 size={15} />
            </button>
            <button
              className="icon-btn"
              onClick={() => run(() => api.redo(), { highlight: false })}
              disabled={busy || streaming || !canRedo}
              title="Вернуть отменённую правку (Ctrl+Shift+Z)"
              aria-label="Вернуть"
            >
              <Redo2 size={15} />
            </button>
          </span>
          <a
            className="frox-btn frox-btn-outline"
            href={api.templateUrl()}
            title="Шаблон плана: тот же план, что открывается по умолчанию — заполните и загрузите обратно"
          >
            <FileDown size={14} />
            <span className="btn__label">Шаблон</span>
          </a>
        </div>
      </header>

      <div className="workspace">
        <section className="chart">
          <div className="chart__bars">
            {narrow && (
              <div className="chart__bar chart__bar--views">
                <div className="frox-tabs chart__views" role="group" aria-label="Вид плана">
                  <button
                    className={`frox-tab${prefs.mobileView === "chart" ? " frox-tab-active" : ""}`}
                    aria-pressed={prefs.mobileView === "chart"}
                    onClick={() => setPrefs((current) => ({ ...current, mobileView: "chart" }))}
                  >
                    Диаграмма
                  </button>
                  <button
                    className={`frox-tab${prefs.mobileView === "list" ? " frox-tab-active" : ""}`}
                    aria-pressed={prefs.mobileView === "list"}
                    onClick={() => setPrefs((current) => ({ ...current, mobileView: "list" }))}
                  >
                    Список
                  </button>
                </div>

                <button
                  className={`frox-btn frox-btn-brand frox-btn-sm chat__open${streaming ? " chat__open--busy" : ""}`}
                  onClick={() => setChatExpanded(true)}
                  title="Открыть агента плана"
                >
                  <Bot size={15} />
                  Агент
                </button>
              </div>
            )}

            <div
              className="chart__bar chart__bar--list"
              style={narrow ? undefined : { width: listWidth }}
            >
              <TableFilter
                filters={filters}
                assignees={assigneeOptions}
                shown={visibleTasks.length}
                total={schedule?.tasks.length ?? 0}
                onChange={setFilters}
              />

              {narrow && prefs.mobileView === "chart" && (
                <select
                  className="frox-select chart__step-select"
                  value={prefs.mobileStep}
                  onChange={(event) =>
                    setPrefs((current) => ({
                      ...current,
                      mobileStep: event.target.value as typeof current.mobileStep,
                    }))
                  }
                  aria-label="Масштаб таймлайна"
                >
                  {MOBILE_STEPS.map((step) => (
                    <option key={step.key} value={step.key}>
                      {step.label}
                    </option>
                  ))}
                </select>
              )}

              {!narrow && (
                <ColumnPicker
                  columns={prefs.columns}
                  hasCustomWidths={Object.keys(prefs.columnWidths).length > 0}
                  onChange={(columns: ColumnKey[]) =>
                    setPrefs((current) => ({ ...current, columns }))
                  }
                  onResetWidths={() => setPrefs((current) => ({ ...current, columnWidths: {} }))}
                />
              )}
            </div>

            {!narrow && (
              <div className="chart__bar chart__bar--time">
                {schedule && totalDays > 0 && (
                  <TimeBrush
                    schedule={schedule}
                    totalDays={totalDays}
                    from={windowFrom}
                    to={windowTo}
                    onChange={setWindow}
                  />
                )}
                <span className="chart__step" title="Шаг таймлайна подбирается под масштаб">
                  {STEP_LABELS[viewMode] ?? ""}
                </span>
              </div>
            )}
          </div>

          {narrow && prefs.mobileView === "list" ? (
            <TaskCards
              tasks={visibleTasks}
              numbers={taskNumbers}
              changed={changed}
              filtered={isFilterActive(filters)}
              onOpen={(id) => {
                setSelectedId(id);
                setOpenTaskId(id);
              }}
              onResetFilters={() => setFilters(EMPTY_FILTERS)}
            />
          ) : visibleSchedule ? (
            <GanttBoard
              schedule={visibleSchedule}
              viewMode={viewMode}
              columnWidth={columnWidth}
              columns={visibleColumns}
              columnWidths={visibleWidths}
              hideList={narrow}
              pixelScroll={narrow}
              numbers={taskNumbers}
              viewDate={viewDate}
              onViewport={setViewport}
              onGeometry={setGeometry}
              onScroll={setScroll}
              pxPerDay={pxPerDay}
              onPan={panDays}
              onColumnWidth={(key, width) =>
                setPrefs((current) => {
                  const columnWidths = { ...current.columnWidths };
                  if (width === null) delete columnWidths[key];
                  else columnWidths[key] = width;
                  return { ...current, columnWidths };
                })
              }
              changed={changed}
              selectedId={selectedId}
              filtered={isFilterActive(filters)}
              onResetFilters={() => setFilters(EMPTY_FILTERS)}
              onSelect={setSelectedId}
              onOpen={(id) => {
                setSelectedId(id);
                setOpenTaskId(id);
              }}
              onReorder={(taskId, anchorId, position) =>
                run(() =>
                  api.reorderTask(taskId, position === "before" ? { before: anchorId } : { after: anchorId }),
                )
              }
              onDrag={(id, start, days) => {
                const task = plan?.tasks.find((candidate) => candidate.id === id);
                run(() =>
                  api.patchTask(id, {
                    start,
                    ...(task && days !== task.duration_days ? { duration_days: days } : {}),
                  }),
                );
              }}
            />
          ) : (
            <div className="chart__frame">
              <div className="chart__empty">
                <span className="hint">Загружаю план…</span>
              </div>
            </div>
          )}

          {schedule && (
            <ProjectSpine
              schedule={schedule}
              // В режиме списка бегунку нечего показывать: диаграммы на экране нет.
              window={narrow && prefs.mobileView === "list" ? null : visibleWindow}
            />
          )}
        </section>

        {(!narrow || chatExpanded) && (
          <ChatPanel
            entries={entries}
            streaming={streaming}
            health={health}
            models={models}
            model={prefs.model}
            mentions={mentions}
            loadingHistory={loadingHistory}
            collapsed={!narrow && chatCollapsed && !chatExpanded}
            expanded={chatExpanded}
            sheet={narrow}
            onModelChange={(model) => setPrefs((current) => ({ ...current, model }))}
            onToggle={() => setChatCollapsed((value) => !value)}
            onToggleExpand={() => {
              if (narrow) {
                setChatExpanded(false);
                return;
              }
              setChatExpanded((value) => !value);
              setChatCollapsed(false);
            }}
            onSend={sendMessage}
            onStop={() => abort.current?.abort()}
          />
        )}
      </div>

      <Toasts toasts={toasts} onDismiss={dismissToast} />

      {openTask && openComputed && (
        <TaskModal
          task={openTask}
          computed={openComputed}
          allTasks={plan?.tasks ?? []}
          successors={successors}
          assignees={assigneeOptions}
          busy={busy}
          onClose={() => setOpenTaskId(null)}
          onSave={async (patch) => {
            const next = await run(() => api.patchTask(openTask.id, patch));
            if (next) setOpenTaskId(null);
          }}
          onDelete={async () => {
            const next = await run(() => api.deleteTask(openTask.id));
            if (next) setOpenTaskId(null);
          }}
        />
      )}
    </div>
  );
}
