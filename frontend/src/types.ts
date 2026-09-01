export interface PlanTask {
  id: string;
  name: string;
  description: string;
  assignee: string;
  duration_days: number;
  predecessors: string[];
  start_no_earlier_than: string | null;
  progress: number;
}

export interface ScheduledTask {
  id: string;
  name: string;
  description: string;
  assignee: string;
  duration_days: number;
  predecessors: string[];
  progress: number;
  start: string;
  end: string;
  is_critical: boolean;
  slack_days: number;
  is_pinned: boolean;
}

export interface Schedule {
  project_start: string;
  project_end: string | null;
  tasks: ScheduledTask[];
  warnings: string[];
}

export interface Plan {
  title: string;
  project_start: string;
  tasks: PlanTask[];
}

export interface HistoryEntry {
  seq: number;
  label: string;
  created_at: string;
  is_current: boolean;
}

export interface PlanPayload {
  session_id: string;
  plan: Plan;
  schedule: Schedule;
  history: HistoryEntry[];
  changed: string[];
  message?: string;
}

export interface ApiFailure {
  message: string;
  details?: string[];
}

export type ChatEvent =
  | { type: "message"; text: string; final?: boolean }
  | { type: "tool_call"; name: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; name: string; text: string; ok: boolean }
  | { type: "plan"; schedule: Schedule; plan: Plan; changed: string[] }
  | { type: "error"; text: string }
  | { type: "done"; tool_calls: number };

export interface ToolTrace {
  name: string;
  args: Record<string, unknown>;
  result?: string;
  ok?: boolean;
}

export interface ChatEntry {
  id: string;
  role: "user" | "agent" | "error";
  text: string;
  tools?: ToolTrace[];
  pending?: boolean;
}

export interface ModelInfo {
  id: string;
  label: string;
  vendor: string;
}

export interface ModelsResponse {
  default: string;
  models: ModelInfo[];
}

/** Колонки списка задач, которые можно скрывать. «Задача» есть всегда. */
export type ColumnKey = "assignee" | "duration" | "start" | "end" | "slack" | "progress";

/** Ширины колонок списка. Ключ "name" — колонка «Задача». */
export type ColumnWidths = Partial<Record<ColumnKey | "name", number>>;

export interface TaskFilters {
  query: string;
  assignee: string;
  criticalOnly: boolean;
  pinnedOnly: boolean;
}

export interface Health {
  ok: boolean;
  llm_configured: boolean;
  model: string | null;
  base_url: string;
}
