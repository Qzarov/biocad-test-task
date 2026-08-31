import { useEffect, useRef, useState } from "react";
import type { ChatEntry, Health, ToolTrace } from "../types";

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
  set_project_start: "меняет старт проекта",
};

interface Props {
  entries: ChatEntry[];
  streaming: boolean;
  health: Health | null;
  onSend: (message: string) => void;
  onStop: () => void;
  onClear: () => void;
}

export function ChatPanel({ entries, streaming, health, onSend, onStop, onClear }: Props) {
  const [draft, setDraft] = useState("");
  const log = useRef<HTMLDivElement>(null);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: "smooth" });
  }, [entries, streaming]);

  const send = () => {
    const message = draft.trim();
    if (!message || streaming) return;
    setDraft("");
    onSend(message);
  };

  return (
    <section className="chat" aria-label="Чат с агентом-планировщиком">
      <header className="chat__head">
        <div>
          <span className="label">Агент плана</span>
          <div className="chat__model">
            {health?.llm_configured ? health.model : "модель не настроена"}
          </div>
        </div>
        <button className="btn btn--ghost btn--sm" onClick={onClear} disabled={streaming}>
          Очистить
        </button>
      </header>

      {health && !health.llm_configured && (
        <div className="notice">
          Чат выключен: не задан ключ LLM. Добавьте <code>OPENROUTER_API_KEY</code> в{" "}
          <code>backend/.env</code> и перезапустите бэкенд — диаграмма и Excel работают и без него.
        </div>
      )}

      <div className="chat__log" ref={log}>
        {entries.length === 0 && (
          <div className="chat__intro">
            <p>
              Опишите правки словами — агент вызовет инструменты плана через MCP и диаграмма
              перестроится. Можно менять сразу много задач.
            </p>
            <div className="suggestions">
              {SUGGESTIONS.map((text) => (
                <button
                  key={text}
                  className="suggestion"
                  onClick={() => setDraft(text)}
                  disabled={streaming}
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
                {entry.text || (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <i className="spinner" /> агент работает…
                  </span>
                )}
              </div>
            )}
          </article>
        ))}
      </div>

      <div className="chat__composer">
        <textarea
          value={draft}
          placeholder="Например: сдвинь всё после трансфера процесса на две недели"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              send();
            }
          }}
          disabled={streaming || (health ? !health.llm_configured : false)}
        />
        <div className="chat__composer-row">
          <span className="hint">Ctrl/⌘ + Enter — отправить</span>
          {streaming ? (
            <button className="btn btn--danger" onClick={onStop}>
              Остановить
            </button>
          ) : (
            <button
              className="btn btn--primary"
              onClick={send}
              disabled={!draft.trim() || (health ? !health.llm_configured : false)}
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
    <div className={`tool${state === "failed" ? " tool--failed" : ""}${state === "running" ? " tool--running" : ""}`}>
      <div className="tool__name">
        <span>{tool.name}</span>
        <span className="label" style={{ letterSpacing: "0.06em" }}>
          {state === "running" ? "выполняется" : TOOL_LABELS[tool.name] ?? "инструмент"}
        </span>
      </div>
      {args && <p className="tool__args">{args}</p>}
      {tool.result && <div className="tool__result">{tool.result}</div>}
    </div>
  );
}
