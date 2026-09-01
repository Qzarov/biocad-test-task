import type { ApiFailure, ChatEvent, Health, ModelsResponse, PlanPayload } from "./types";

const BASE = (import.meta.env.VITE_API_BASE ?? "/api").replace(/\/$/, "");
const SESSION_KEY = "gantt-agent-session";

export function sessionId(): string {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    localStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

export class ApiError extends Error {
  details: string[];
  constructor(failure: ApiFailure) {
    super(failure.message);
    this.details = failure.details ?? [];
  }
}

async function unwrap(response: Response): Promise<never> {
  let failure: ApiFailure = { message: `Сервер ответил ${response.status}` };
  try {
    const body = await response.json();
    const detail = body?.detail ?? body;
    if (typeof detail === "string") failure = { message: detail };
    else if (detail?.message) failure = { message: detail.message, details: detail.details };
  } catch {
    /* keep the status-code message */
  }
  throw new ApiError(failure);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${BASE}${path}${path.includes("?") ? "&" : "?"}session_id=${sessionId()}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      "X-Session-Id": sessionId(),
      ...(init.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) await unwrap(response);
  return (await response.json()) as T;
}

export const api = {
  health: () => request<Health>("/health"),
  models: () => request<ModelsResponse>("/models"),
  plan: () => request<PlanPayload>("/plan"),
  reset: () => request<PlanPayload>("/plan/reset", { method: "POST" }),
  undo: () => request<PlanPayload>("/plan/undo", { method: "POST" }),

  importXlsx: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<PlanPayload>("/plan/import", { method: "POST", body: form });
  },

  exportUrl: () => `${BASE}/plan/export?session_id=${sessionId()}`,

  createTask: (body: {
    name: string;
    description?: string;
    assignee?: string;
    duration_days: number;
    predecessors?: string[];
  }) => request<PlanPayload>("/plan/tasks", { method: "POST", body: JSON.stringify(body) }),

  patchTask: (
    id: string,
    body: {
      name?: string;
      description?: string;
      assignee?: string;
      duration_days?: number;
      progress?: number;
      predecessors?: string[];
      start?: string;
      unpin?: boolean;
    },
  ) => request<PlanPayload>(`/plan/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),

  deleteTask: (id: string) =>
    request<PlanPayload>(`/plan/tasks/${encodeURIComponent(id)}`, { method: "DELETE" }),

  setProjectStart: (start: string) =>
    request<PlanPayload>("/plan/project-start", { method: "POST", body: JSON.stringify({ start }) }),

  clearChat: () => request<{ ok: boolean }>("/chat/clear", { method: "POST" }),
};

/** Stream one agent turn. Calls `onEvent` for every server-sent event. */
export async function streamChat(
  message: string,
  onEvent: (event: ChatEvent) => void,
  options: { signal?: AbortSignal; model?: string } = {},
): Promise<void> {
  const { signal, model } = options;
  const response = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Session-Id": sessionId() },
    body: JSON.stringify({ message, session_id: sessionId(), model }),
    signal,
  });
  if (!response.ok) await unwrap(response);
  if (!response.body) throw new ApiError({ message: "Ответ без тела — стрим недоступен" });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const payload = frame
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("");
      if (payload) {
        try {
          onEvent(JSON.parse(payload) as ChatEvent);
        } catch {
          /* ignore a partial frame we cannot parse */
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}
