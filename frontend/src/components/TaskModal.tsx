import { useEffect, useMemo, useState } from "react";
import { STATUS_LABELS, STATUS_ORDER } from "../types";
import type { PlanTask, ScheduledTask, TaskStatus } from "../types";
import { formatDate, plural } from "../format";

interface Props {
  task: PlanTask;
  computed: ScheduledTask;
  allTasks: PlanTask[];
  successors: PlanTask[];
  assignees: string[];
  busy: boolean;
  onClose: () => void;
  onSave: (patch: {
    name?: string;
    description?: string;
    assignee?: string;
    duration_days?: number;
    progress?: number;
    status?: string;
    predecessors?: string[];
    successors?: string[];
    start?: string;
    unpin?: boolean;
  }) => void;
  onDelete: () => void;
}

/** Детали задачи. Сверху — то, что считает планировщик и что нельзя ввести
 *  руками, ниже — поля. Связи правятся с обеих сторон: сама связь хранится у
 *  зависимой задачи, но думать удобно и «после кого», и «кто после». */
export function TaskModal({
  task,
  computed,
  allTasks,
  successors,
  assignees,
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
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [predecessors, setPredecessors] = useState<string[]>(task.predecessors);
  const [successorIds, setSuccessorIds] = useState<string[]>(successors.map((item) => item.id));
  const [pin, setPin] = useState(task.start_no_earlier_than ?? "");
  const [linkQuery, setLinkQuery] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const numbers = useMemo(() => {
    const map: Record<string, number> = {};
    allTasks.forEach((item, index) => {
      map[item.id] = index + 1;
    });
    return map;
  }, [allTasks]);

  const candidates = useMemo(() => {
    const query = linkQuery.trim().toLowerCase();
    return allTasks
      .filter((candidate) => candidate.id !== task.id)
      .filter((candidate) => !query || candidate.name.toLowerCase().includes(query));
  }, [allTasks, task.id, linkQuery]);

  const initialSuccessors = successors.map((item) => item.id).join(",");
  const dirty =
    name !== task.name ||
    description !== task.description ||
    assignee !== task.assignee ||
    Number(duration) !== task.duration_days ||
    Number(progress) !== task.progress ||
    status !== task.status ||
    predecessors.join(",") !== task.predecessors.join(",") ||
    successorIds.join(",") !== initialSuccessors ||
    pin !== (task.start_no_earlier_than ?? "");

  const save = () => {
    const patch: Parameters<Props["onSave"]>[0] = {};
    if (name !== task.name) patch.name = name;
    if (description !== task.description) patch.description = description;
    if (assignee !== task.assignee) patch.assignee = assignee;
    if (Number(duration) !== task.duration_days) patch.duration_days = Number(duration);
    if (Number(progress) !== task.progress) patch.progress = Number(progress);
    if (status !== task.status) patch.status = status;
    if (predecessors.join(",") !== task.predecessors.join(",")) patch.predecessors = predecessors;
    if (successorIds.join(",") !== initialSuccessors) patch.successors = successorIds;
    if (pin !== (task.start_no_earlier_than ?? "")) {
      if (pin) patch.start = pin;
      else patch.unpin = true;
    }
    onSave(patch);
  };

  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((item) => item !== id) : [...list, id];

  return (
    <div className="overlay" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal__head">
          <div>
            <span className="modal__id num">
              #{numbers[task.id] ?? "—"} · {task.id}
            </span>
            <h2 className="modal__title">{task.name}</h2>
            <div className="chips">
              <span className={`chip chip--status-${computed.status}`}>
                {STATUS_LABELS[computed.status]}
              </span>
              {computed.is_critical ? (
                <span className="chip chip--critical">критический путь</span>
              ) : (
                <span className="chip">
                  запас {plural(computed.slack_days, "день", "дня", "дней")}
                </span>
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
              <span className="readout__value">
                {computed.is_critical ? "0" : computed.slack_days}
              </span>
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
              {/* Список подсказывает тех, кто уже есть в плане (меньше опечаток,
                  из-за которых появляются «двойники»), но нового человека можно
                  просто напечатать. */}
              <input
                id="task-assignee"
                className="frox-input"
                list="assignee-options"
                placeholder="не назначен"
                value={assignee}
                onChange={(event) => setAssignee(event.target.value)}
              />
              <datalist id="assignee-options">
                {assignees.map((option) => (
                  <option key={option} value={option} />
                ))}
              </datalist>
            </div>
            <div className="frox-field">
              <label className="frox-field-label" htmlFor="task-status">
                Статус
              </label>
              <select
                id="task-status"
                className="frox-select"
                value={status}
                onChange={(event) => setStatus(event.target.value as TaskStatus)}
              >
                {STATUS_ORDER.map((option) => (
                  <option key={option} value={option}>
                    {STATUS_LABELS[option]}
                  </option>
                ))}
              </select>
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
            <div className="links__head">
              <span className="frox-field-label">Связи</span>
              <input
                className="frox-input links__search"
                type="search"
                value={linkQuery}
                placeholder="Найти задачу"
                onChange={(event) => setLinkQuery(event.target.value)}
              />
            </div>
            <div className="links">
              <div className="links__col">
                <span className="links__title">Идут до этой задачи</span>
                <div className="deps">
                  {candidates.length === 0 && <span className="hint">Ничего не найдено</span>}
                  {candidates.map((candidate) => (
                    <label key={candidate.id} className="frox-toggle-label">
                      <input
                        className="frox-checkbox"
                        type="checkbox"
                        checked={predecessors.includes(candidate.id)}
                        disabled={successorIds.includes(candidate.id)}
                        onChange={() => setPredecessors((current) => toggle(current, candidate.id))}
                      />
                      <span className="links__num num">#{numbers[candidate.id]}</span>
                      <span className="links__name">{candidate.name}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="links__col">
                <span className="links__title">Зависят от этой</span>
                <div className="deps">
                  {candidates.length === 0 && <span className="hint">Ничего не найдено</span>}
                  {candidates.map((candidate) => (
                    <label key={candidate.id} className="frox-toggle-label">
                      <input
                        className="frox-checkbox"
                        type="checkbox"
                        checked={successorIds.includes(candidate.id)}
                        disabled={predecessors.includes(candidate.id)}
                        onChange={() => setSuccessorIds((current) => toggle(current, candidate.id))}
                      />
                      <span className="links__num num">#{numbers[candidate.id]}</span>
                      <span className="links__name">{candidate.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <span className="hint">
              Задача не может быть одновременно до и после другой — противоположный чекбокс
              блокируется. Циклы отклоняет сервер.
            </span>
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
