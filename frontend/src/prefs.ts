import type { ColumnKey } from "./types";

/** Настройки вида: живут в браузере, потому что это предпочтения одного человека,
 *  а не часть плана. Читаются один раз при старте, пишутся при каждом изменении. */

const KEY = "gantt-agent-prefs";

export interface Prefs {
  columns: ColumnKey[];
  zoom: number; // 0..100, положение ползунка масштаба
  model: string | null;
}

export const DEFAULT_PREFS: Prefs = {
  columns: ["assignee", "duration"],
  zoom: 45,
  model: null,
};

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      columns: Array.isArray(parsed.columns) ? (parsed.columns as ColumnKey[]) : DEFAULT_PREFS.columns,
      zoom: typeof parsed.zoom === "number" ? Math.min(100, Math.max(0, parsed.zoom)) : DEFAULT_PREFS.zoom,
      model: typeof parsed.model === "string" ? parsed.model : null,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* приватный режим или переполненное хранилище — настройки просто не сохранятся */
  }
}
