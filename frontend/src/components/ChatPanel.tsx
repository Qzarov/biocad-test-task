import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatEntry, Health, Mention, ModelInfo, ToolTrace } from "../types";
import { Collapsible } from "./Collapsible";

const SUGGESTIONS = [
  "Перенеси клиническое исследование на 3 недели позже и покажи, что поехало",
  "Переназначь все задачи Егоровой М. на Иванову Т. — она перегружена",
  "Добавь задачу «Аудит поставщика сырья», 10 дней, до трансфера процесса",
  "Сократи подготовку досье до 14 дней и убери зависимость от стабильности",
];

const TOOL_LABELS: Record<string, string> = {
  get_plan: "читает план",
  list_assignees: "смотрит загрузку",
  add_task: "добавляет задачу",
  update_task: "правит задачу",
  delete_task: "удаляет задачу",
  set_predecessors: "меняет зависимости",
  shift_task: "сдвигает задачу",
  move_task_to: "закрепляет дату",
  unpin_task: "снимает фиксацию",
  reassign_tasks: "переназначает исполнителя",
  reorder_task: "меняет порядок",
  set_project_start: "меняет старт проекта",
};

const MENTION_LIMIT = 8;

interface Props {
  entries: ChatEntry[];
  streaming: boolean;
  loadingHistory: boolean;
  health: Health | null;
  models: ModelInfo[];
  model: string | null;
  mentions: Mention[];
  onModelChange: (model: string) => void;
  onSend: (message: string) => void;
  onStop: () => void;
}

export function ChatPanel({
  entries,
  streaming,
  loadingHistory,
  health,
  models,
  model,
  mentions,
  onModelChange,
  onSend,
  onStop,
}: Props) {
  const [draft, setDraft] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: "smooth" });
  }, [entries, streaming]);

  const matches = useMemo(() => {
    if (mentionQuery === null) return [];
    const query = mentionQuery.trim().toLowerCase();
    if (!query) return mentions.slice(0, MENTION_LIMIT);

    // Совпадение в начале строки или слова весит больше, чем внутри слова:
    // иначе на «@Ег» первым выпадает «подготовка рЕГистрационного досье», а не
    // «Егорова М.», и Enter вставляет не то, что человек имел в виду.
    const score = (item: Mention): number => {
      const label = item.label.toLowerCase();
      if (item.number !== undefined && String(item.number).startsWith(query)) return 0;
      if (label.startsWith(query)) return 0;
      if (label.split(/[\s(«"-]+/).some((word) => word.startsWith(query))) return 1;
      return label.includes(query) ? 2 : 99;
    };

    return mentions
      .map((item) => ({ item, rank: score(item) }))
      .filter((row) => row.rank < 99)
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          (a.item.kind === b.item.kind ? 0 : a.item.kind === "person" ? -1 : 1) ||
          (a.item.number ?? 0) - (b.item.number ?? 0),
      )
      .slice(0, MENTION_LIMIT)
      .map((row) => row.item);
  }, [mentions, mentionQuery]);

  useEffect(() => {
    setActive(0);
  }, [mentionQuery]);

  /** Токен под курсором: «@» плюс всё, что набрано после него без пробелов. */
  const detectMention = (value: string, caret: number): string | null => {
    const match = /(?:^|\s)@([^\s@]{0,40})$/.exec(value.slice(0, caret));
    return match ? match[1] : null;
  };

  const accept = (item: Mention) => {
    const element = input.current;
    const caret = element?.selectionStart ?? draft.length;
    const start = draft.slice(0, caret).lastIndexOf("@");
    if (start < 0) return;
    const next = `${draft.slice(0, start)}${item.insert} ${draft.slice(caret)}`;
    setDraft(next);
    setMentionQuery(null);
    const position = start + item.insert.length + 1;
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(position, position);
    });
  };

  const send = () => {
    const message = draft.trim();
    if (!message || streaming) return;
    setDraft("");
    setMentionQuery(null);
    onSend(message);
  };

  const disabled = streaming || (health ? !health.llm_configured : false);
  const menuOpen = mentionQuery !== null && matches.length > 0;

  return (
    <section className="chat" aria-label="Чат с агентом-планировщиком">
      <header className="chat__head">
        <div className="chat__head-row">
          <div className="chat__title">Агент плана</div>
        </div>

        {models.length > 0 ? (
          <label className="chat__model-picker">
            <span className="chat__model-label">Модель</span>
            <select
              className="frox-select"
              value={model ?? ""}
              disabled={streaming}
              onChange={(event) => onModelChange(event.target.value)}
              title="Модель меняется на следующий запрос"
            >
              {models.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label} · {option.vendor}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="chat__model">
            {health?.llm_configured ? health.model : "модель не настроена"}
          </div>
        )}
      </header>

      {health && !health.llm_configured && (
        <div className="notice">
          Чат выключен: не задан ключ LLM. Добавьте <code>OPENROUTER_API_KEY</code> в{" "}
          <code>backend/.env</code> и перезапустите бэкенд — диаграмма и Excel работают и без него.
        </div>
      )}

      <div className="chat__log" ref={log}>
        {loadingHistory && <span className="hint">Загружаю переписку…</span>}

        {!loadingHistory && entries.length === 0 && (
          <div className="chat__intro">
            <p>
              Опишите правки словами — агент вызовет инструменты плана через MCP и диаграмма
              перестроится. Можно менять сразу много задач. Через <code>@</code> вставляется ссылка
              на задачу или человека, номером из списка тоже можно сослаться: <code>#5</code>.
            </p>
            <div className="suggestions">
              {SUGGESTIONS.map((text) => (
                <button
                  key={text}
                  className="suggestion"
                  onClick={() => setDraft(text)}
                  disabled={disabled}
                >
                  {text}
                </button>
              ))}
            </div>
          </div>
        )}

        {entries.map((entry) => (
          <article key={entry.id} className={`turn turn--${entry.role}`}>
            {entry.tools && entry.tools.length > 0 && (
              <div className="trace">
                {entry.tools.map((tool, index) => (
                  <ToolCard key={`${tool.name}-${index}`} tool={tool} />
                ))}
              </div>
            )}
            {(entry.text || entry.pending) && (
              <div className="turn__body">
                {entry.text ? (
                  <Collapsible text={entry.text} lines={4} />
                ) : (
                  <span className="turn__working">
                    <i className="spinner" /> агент работает…
                  </span>
                )}
              </div>
            )}
          </article>
        ))}
      </div>

      <div className="chat__composer">
        {menuOpen && (
          <div className="mentions" role="listbox" aria-label="Задачи и исполнители">
            {matches.map((item, index) => (
              <button
                key={`${item.kind}-${item.label}`}
                className={`mentions__item${index === active ? " mentions__item--active" : ""}`}
                role="option"
                aria-selected={index === active}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  accept(item);
                }}
              >
                {item.number !== undefined && (
                  <span className="mentions__num num">#{item.number}</span>
                )}
                <span className="mentions__label">{item.label}</span>
                <span className="mentions__hint">{item.hint}</span>
              </button>
            ))}
          </div>
        )}

        <textarea
          ref={input}
          className="frox-textarea"
          value={draft}
          placeholder="Например: сдвинь #5 на две недели или разгрузи @Егорова М."
          onChange={(event) => {
            setDraft(event.target.value);
            setMentionQuery(detectMention(event.target.value, event.target.selectionStart ?? 0));
          }}
          onClick={(event) => {
            const element = event.currentTarget;
            setMentionQuery(detectMention(element.value, element.selectionStart ?? 0));
          }}
          onBlur={() => setMentionQuery(null)}
          onKeyDown={(event) => {
            if (menuOpen) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((value) => (value + 1) % matches.length);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((value) => (value - 1 + matches.length) % matches.length);
                return;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                accept(matches[active]);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setMentionQuery(null);
                return;
              }
            }
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              send();
            }
          }}
          disabled={disabled}
        />
        <div className="chat__composer-row">
          <span className="hint">
            {menuOpen ? "↑↓ — выбор, Enter — вставить" : "Ctrl/⌘ + Enter — отправить, @ — ссылка"}
          </span>
          {streaming ? (
            <button className="frox-btn frox-btn-outline frox-btn-danger" onClick={onStop}>
              Остановить
            </button>
          ) : (
            <button
              className="frox-btn frox-btn-brand"
              onClick={send}
              disabled={!draft.trim() || disabled}
            >
              Отправить
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function ToolCard({ tool }: { tool: ToolTrace }) {
  const state = tool.result === undefined ? "running" : tool.ok ? "done" : "failed";
  const args = Object.entries(tool.args ?? {})
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join("|") : String(value)}`)
    .join("  ");

  return (
    <div
      className={`tool${state === "failed" ? " tool--failed" : ""}${state === "running" ? " tool--running" : ""}`}
    >
      <div className="tool__name">
        <span>{tool.name}</span>
        <span className="tool__state">
          {state === "running" ? "выполняется" : TOOL_LABELS[tool.name] ?? "инструмент"}
        </span>
      </div>
      {args && <p className="tool__args">{args}</p>}
      {tool.result && <Collapsible className="tool__result" text={tool.result} lines={4} />}
    </div>
  );
}
