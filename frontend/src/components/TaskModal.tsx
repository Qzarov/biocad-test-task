import { useEffect, useMemo, useState } from "react";
import type { PlanTask, ScheduledTask } from "../types";
import { formatDate, plural } from "../format";

interface Props {
  task: PlanTask;
  computed: ScheduledTask;
  allTasks: PlanTask[];
  successors: PlanTask[];
  busy: boolean;
  onClose: () => void;
  onSave: (patch: {
    name?: string;
    description?: string;
    assignee?: string;
    duration_days?: number;
    progress?: number;
    predecessors?: string[];
    start?: string;
    unpin?: boolean;
  }) => void;
  onDelete: () => void;
}

/** Task details. Read-only facts on top (they come from the scheduler and cannot
 *  be typed in), editable fields below — the distinction is the point of the
 *  layout: dates are derived, everything else is input. */
export function TaskModal({
  task,
  computed,
  allTasks,
  successors,
  busy,
  onClose,
  onSave,
  onDelete,
}: Props) {
  const [name, setName] = useState(task.name);
  const [description, setDescription] = useState(task.description);
  const [assignee, setAssignee] = useState(task.assignee);
  const [duration, setDuration] = useState(String(task.duration_days));
  const [progress, setProgress] = useState(String(task.progress));
  const [predecessors, setPredecessors] = useState<string[]>(task.predecessors);
  const [pin, setPin] = useState(task.start_no_earlier_than ?? "");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const candidates = useMemo(
    () => allTasks.filter((candidate) => candidate.id !== task.id),
    [allTasks, task.id],
  );

  const dirty =
    name !== task.name ||
    description !== task.description ||
    assignee !== task.assignee ||
    Number(duration) !== task.duration_days ||
    Number(progress) !== task.progress ||
    predecessors.join(",") !== task.predecessors.join(",") ||
    pin !== (task.start_no_earlier_than ?? "");

  const save = () => {
    const patch: Parameters<Props["onSave"]>[0] = {};
    if (name !== task.name) patch.name = name;
    if (description !== task.description) patch.description = description;
    if (assignee !== task.assignee) patch.assignee = assignee;
    if (Number(duration) !== task.duration_days) patch.duration_days = Number(duration);
    if (Number(progress) !== task.progress) patch.progress = Number(progress);
    if (predecessors.join(",") !== task.predecessors.join(",")) patch.predecessors = predecessors;
    if (pin !== (task.start_no_earlier_than ?? "")) {
      if (pin) patch.start = pin;
      else patch.unpin = true;
    }
    onSave(patch);
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal__head">
          <div>
            <span className="modal__id num">{task.id}</span>
            <h2 className="modal__title">{task.name}</h2>
            <div className="chips">
              {computed.is_critical ? (
                <span className="chip chip--critical">критический путь</span>
              ) : (
                <span className="chip">запас {plural(computed.slack_days, "день", "дня", "дней")}</span>
              )}
              {computed.is_pinned && <span className="chip chip--pinned">дата закреплена</span>}
              {computed.progress > 0 && <span className="chip">готово {computed.progress}%</span>}
            </div>
          </div>
          <button className="frox-btn frox-btn-outline frox-btn-sm" onClick={onClose}>
            Закрыть
          </button>
        </header>

        <div className="modal__body">
          <div className="readout">
            <div className="readout__item">
              <span className="readout__label">Начало</span>
              <span className="readout__value">{formatDate(computed.start)}</span>
            </div>
            <div className="readout__item">
              <span className="readout__label">Окончание</span>
              <span className="readout__value">{formatDate(computed.end)}</span>
            </div>
            <div className="readout__item">
              <span className="readout__label">Длительность</span>
              <span className="readout__value">{computed.duration_days} дн.</span>
            </div>
            <div className="readout__item">
              <span className="readout__label">Запас</span>
              <span className="readout__value">{computed.is_critical ? "0" : computed.slack_days}</span>
            </div>
          </div>

          <div className="frox-field">
            <label className="frox-field-label" htmlFor="task-name">
              Название
            </label>
            <input
              id="task-name"
              className="frox-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="frox-field">
            <label className="frox-field-label" htmlFor="task-description">
              Описание
            </label>
            <textarea
              id="task-description"
              className="frox-textarea"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <div className="field-row">
            <div className="frox-field">
              <label className="frox-field-label" htmlFor="task-assignee">
                Исполнитель
              </label>
              <input
                id="task-assignee"
                className="frox-input"
                value={assignee}
                onChange={(event) => setAssignee(event.target.value)}
              />
            </div>
            <div className="frox-field">
              <label className="frox-field-label" htmlFor="task-duration">
                Длительность, дн.
              </label>
              <input
                id="task-duration"
                className="frox-input"
                type="number"
                min={1}
                value={duration}
                onChange={(event) => setDuration(event.target.value)}
              />
            </div>
            <div className="frox-field">
              <label className="frox-field-label" htmlFor="task-progress">
                Прогресс, %
              </label>
              <input
                id="task-progress"
                className="frox-input"
                type="number"
                min={0}
                max={100}
                value={progress}
                onChange={(event) => setProgress(event.target.value)}
              />
            </div>
            <div className="frox-field">
              <label className="frox-field-label" htmlFor="task-pin">
                Не раньше
              </label>
              <input
                id="task-pin"
                className="frox-input"
                type="date"
                value={pin}
                onChange={(event) => setPin(event.target.value)}
              />
            </div>
          </div>

          <div className="frox-field">
            <span className="frox-field-label">Предшественники</span>
            <div className="deps">
              {candidates.length === 0 && <span className="hint">Других задач в плане нет</span>}
              {candidates.map((candidate) => (
                <label key={candidate.id} className="frox-toggle-label">
                  <input
                    className="frox-checkbox"
                    type="checkbox"
                    checked={predecessors.includes(candidate.id)}
                    onChange={(event) =>
                      setPredecessors((current) =>
                        event.target.checked
                          ? [...current, candidate.id]
                          : current.filter((id) => id !== candidate.id),
                      )
                    }
                  />
                  <span>{candidate.name}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="frox-field">
            <span className="frox-field-label">Зависят от этой задачи</span>
            {successors.length ? (
              <div className="linkrow">
                {successors.map((successor) => (
                  <span key={successor.id} className="linkrow__item">
                    {successor.name}
                  </span>
                ))}
              </div>
            ) : (
              <span className="hint">Ничего не зависит — задача на конце цепочки</span>
            )}
          </div>
        </div>

        <footer className="modal__foot">
          <button
            className="frox-btn frox-btn-outline frox-btn-danger"
            onClick={onDelete}
            disabled={busy}
          >
            Удалить задачу
          </button>
          <div className="modal__foot-right">
            <button className="frox-btn frox-btn-outline" onClick={onClose} disabled={busy}>
              Отмена
            </button>
            <button className="frox-btn frox-btn-brand" onClick={save} disabled={busy || !dirty}>
              {busy ? "Сохраняю…" : "Сохранить"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
