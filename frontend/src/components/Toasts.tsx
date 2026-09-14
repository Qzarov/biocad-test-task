import { useEffect } from "react";
import { X } from "lucide-react";

/** Всплывающие уведомления в правом верхнем углу.
 *
 * Раньше сообщения об изменениях занимали строку над диаграммой и сдвигали
 * содержимое; теперь они не трогают раскладку. Обычное уведомление живёт 3
 * секунды, ошибка — дольше и с крестиком: в ней бывает список проблем по
 * строкам файла, его нужно успеть прочитать.
 */
export interface Toast {
  id: number;
  kind: "info" | "error";
  message: string;
  details?: string[];
}

const LIFETIME = { info: 3000, error: 9000 };

interface Props {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}

export function Toasts({ toasts, onDismiss }: Props) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), LIFETIME[toast.kind]);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.kind, onDismiss]);

  return (
    <div className={`toast toast--${toast.kind}`}>
      <div className="toast__body">
        <span className="toast__message">{toast.message}</span>
        {toast.details && toast.details.length > 0 && (
          <ul className="toast__details">
            {toast.details.slice(0, 5).map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
            {toast.details.length > 5 && <li>…и ещё {toast.details.length - 5}</li>}
          </ul>
        )}
      </div>
      <button className="toast__close" onClick={() => onDismiss(toast.id)} aria-label="Закрыть">
        <X size={13} />
      </button>
    </div>
  );
}
