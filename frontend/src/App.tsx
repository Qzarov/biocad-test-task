import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ViewMode } from "gantt-task-react";
import { ApiError, api, sessionId, streamChat } from "./api";
import { ChatPanel } from "./components/ChatPanel";
import { ColumnPicker } from "./components/ColumnPicker";
import { GanttBoard } from "./components/GanttBoard";
import { ProjectSpine } from "./components/ProjectSpine";
import { EMPTY_FILTERS, TableFilter, applyFilters, isFilterActive } from "./components/TableFilter";
import { TaskModal } from "./components/TaskModal";
import { daysBetween, formatDate, plural } from "./format";
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

const VIEW_MODES: { mode: ViewMode; label: string }[] = [
  { mode: ViewMode.Day, label: "День" },
  { mode: ViewMode.Week, label: "Неделя" },
  { mode: ViewMode.Month, label: "Месяц" },
];

/** Ползунок масштаба меняет ширину колонки таймлайна внутри выбранного режима:
 *  в днях разумный диапазон один, в месяцах — другой. Само положение ползунка
 *  общее, поэтому при переключении режима «плотность» сохраняется. */
const ZOOM_RANGES: Partial<Record<ViewMode, [number, number]>> = {
  [ViewMode.Day]: [22, 84],
  [ViewMode.Week]: [44, 156],
  [ViewMode.Month]: [72, 288],
};

function columnWidthFor(mode: ViewMode, zoom: number): number {
  const [min, max] = ZOOM_RANGES[mode] ?? [40, 140];
  return Math.round(min + ((max - min) * Math.min(100, Math.max(0, zoom))) / 100);
}

interface Notice {
  kind: "info" | "error";
  message: string;
  details?: string[];
}

export default function App() {
  const [payload, setPayload] = useState<PlanPayload | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(ViewMode.Week);
  const [viewModeTouched, setViewModeTouched] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [changed, setChanged] = useState<string[]>([]);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [prefs, setPrefs] = useState(loadPrefs);
  const [filters, setFilters] = useState<TaskFilters>(EMPTY_FILTERS);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const highlightTimer = useRef<number | null>(null);

  const fail = useCallback((error: unknown) => {
    if (error instanceof ApiError) {
      setNotice({ kind: "error", message: error.message, details: error.details });
    } else {
      setNotice({ kind: "error", message: String(error) });
    }
  }, []);

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
        if (next.message) setNotice({ kind: "info", message: next.message });
        return next;
      } catch (error) {
        fail(error);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [fail, highlight],
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
  const columnWidth = columnWidthFor(viewMode, prefs.zoom);

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
        insert: `#${index + 1} «${task.name}»`,
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

  const criticalCount = schedule?.tasks.filter((task) => task.is_critical).length ?? 0;
  const assignees = new Set((plan?.tasks ?? []).map((task) => task.assignee).filter(Boolean));
  const totalDays =
    schedule?.project_end ? daysBetween(schedule.project_start, schedule.project_end) : 0;

  // A year-long plan is unreadable week by week; a two-week plan looks empty by
  // month. So the initial zoom follows the plan, until the user picks one.
  useEffect(() => {
    if (viewModeTouched || !totalDays) return;
    setViewMode(totalDays > 120 ? ViewMode.Month : ViewMode.Week);
  }, [totalDays, viewModeTouched]);

  const sendMessage = useCallback(
    async (message: string) => {
      const turnId = `turn-${Date.now()}`;
      setEntries((current) => [
        ...current,
        { id: `${turnId}-user`, role: "user", text: message },
        { id: turnId, role: "agent", text: "", tools: [], pending: true },
      ]);
      setStreaming(true);
      setNotice(null);
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
          <div className="masthead__eyebrow">
            <span>План проекта</span>
            <span className="num">сессия {sessionId()}</span>
          </div>
          <h1>{plan?.title ?? "План проекта"}</h1>
          <div className="masthead__meta">
            <span className="metric">
              <span className="metric__label">Старт</span>
              <input
                className="metric__date"
                type="date"
                value={schedule?.project_start ?? ""}
                onChange={(event) =>
                  event.target.value && run(() => api.setProjectStart(event.target.value))
                }
                disabled={busy || streaming}
              />
            </span>
            <span className="metric">
              <span className="metric__label">Финиш</span>
              <span className="metric__value">{formatDate(schedule?.project_end)}</span>
            </span>
            <span className="metric">
              <span className="metric__label">Длительность</span>
              <span className="metric__value">{totalDays ? plural(totalDays, "день", "дня", "дней") : "—"}</span>
            </span>
            <span className="metric">
              <span className="metric__label">Задач</span>
              <span className="metric__value">{plan?.tasks.length ?? 0}</span>
            </span>
            <span className="metric">
              <span className="metric__label">Критический путь</span>
              <span className="metric__value metric__value--critical">
                {criticalCount ? plural(criticalCount, "задача", "задачи", "задач") : "—"}
              </span>
            </span>
            <span className="metric">
              <span className="metric__label">Исполнителей</span>
              <span className="metric__value">{assignees.size}</span>
            </span>
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
          >
            Загрузить Excel
          </button>
          <a className="frox-btn frox-btn-brand" href={api.exportUrl()}>
            Скачать Excel
          </a>
          <button
            className="frox-btn frox-btn-outline"
            onClick={() => run(() => api.undo(), { highlight: false })}
            disabled={busy || streaming || (payload?.history?.length ?? 0) < 2}
            title="Откатить последнюю правку"
          >
            Откатить
          </button>
          <button
            className="frox-btn frox-btn-outline"
            onClick={() => {
              setEntries([]);
              run(() => api.reset(), { highlight: false });
            }}
            disabled={busy || streaming}
          >
            Демо-план
          </button>
        </div>

        {schedule && <ProjectSpine schedule={schedule} />}
      </header>

      <div className="workspace">
        <section className="chart">
          <div className="chart__toolbar">
            <TableFilter
              filters={filters}
              assignees={assigneeOptions}
              shown={visibleTasks.length}
              total={schedule?.tasks.length ?? 0}
              onChange={setFilters}
            />

            <div className="chart__view">
              <div className="frox-tabs" role="group" aria-label="Шаг таймлайна">
                {VIEW_MODES.map((option) => (
                  <button
                    key={option.label}
                    className={`frox-tab${viewMode === option.mode ? " frox-tab-active" : ""}`}
                    aria-pressed={viewMode === option.mode}
                    onClick={() => {
                      setViewMode(option.mode);
                      setViewModeTouched(true);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>

              <label className="zoom" title="Масштаб таймлайна">
                <span className="zoom__label">Масштаб</span>
                <input
                  className="zoom__slider"
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={prefs.zoom}
                  onChange={(event) =>
                    setPrefs((current) => ({ ...current, zoom: Number(event.target.value) }))
                  }
                  aria-label="Масштаб таймлайна"
                />
                <span className="zoom__value num">{columnWidth}px</span>
              </label>

              <ColumnPicker
                columns={prefs.columns}
                hasCustomWidths={Object.keys(prefs.columnWidths).length > 0}
                onChange={(columns: ColumnKey[]) =>
                  setPrefs((current) => ({ ...current, columns }))
                }
                onResetWidths={() => setPrefs((current) => ({ ...current, columnWidths: {} }))}
              />
            </div>
          </div>

          {notice ? (
            <div
              className={`notice${notice.kind === "error" ? " notice--error" : ""}`}
              style={{ margin: "0 0 12px" }}
            >
              <strong>{notice.message}</strong>
              {notice.details && notice.details.length > 0 && (
                <ul>
                  {notice.details.slice(0, 6).map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <span className="hint chart__tip">
              Клик по строке — выделить, двойной клик — детали. Полоску можно тянуть по таймлайну,
              снизу диаграммы — ползунок прокрутки.
            </span>
          )}

          {visibleSchedule ? (
            <GanttBoard
              schedule={visibleSchedule}
              viewMode={viewMode}
              columnWidth={columnWidth}
              columns={prefs.columns}
              columnWidths={prefs.columnWidths}
              numbers={taskNumbers}
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
        </section>

        <ChatPanel
          entries={entries}
          streaming={streaming}
          health={health}
          models={models}
          model={prefs.model}
          mentions={mentions}
          loadingHistory={loadingHistory}
          onModelChange={(model) => setPrefs((current) => ({ ...current, model }))}
          onSend={sendMessage}
          onStop={() => abort.current?.abort()}
          onClear={() => {
            api
              .clearChat()
              .then(() => setEntries([]))
              .catch(fail);
          }}
        />
      </div>

      <footer className="statusbar">
        <i className={`statusbar__dot${health?.llm_configured ? "" : " statusbar__dot--off"}`} />
        <span>
          {health?.llm_configured
            ? `LLM: ${health.model} через MCP-инструменты`
            : "LLM не настроен — чат недоступен"}
        </span>
        <span className="statusbar__spacer" />
        {payload?.history?.length ? (
          <span>
            История: {payload.history.length} шаг(ов), текущий —{" "}
            {payload.history.find((item) => item.is_current)?.label ?? "—"}
          </span>
        ) : null}
        {schedule?.warnings?.length ? <span>Предупреждений: {schedule.warnings.length}</span> : null}
      </footer>

      {openTask && openComputed && (
        <TaskModal
          task={openTask}
          computed={openComputed}
          allTasks={plan?.tasks ?? []}
          successors={successors}
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
