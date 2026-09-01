import type { ColumnKey, ColumnWidths } from "./types";

/** Настройки вида: живут в браузере, потому что это предпочтения одного человека,
 *  а не часть плана. Читаются один раз при старте, пишутся при каждом изменении. */

const KEY = "gantt-agent-prefs";

export interface Prefs {
  columns: ColumnKey[];
  columnWidths: ColumnWidths; // только изменённые вручную; остальное — по умолчанию
  // Длина окна просмотра в днях; null — «весь проект». Позиция окна не
  // сохраняется: возвращаться хочется к масштабу, а не к месту прокрутки.
  windowDays: number | null;
  model: string | null;
}

export const DEFAULT_PREFS: Prefs = {
  columns: ["assignee", "duration"],
  columnWidths: {},
  windowDays: null,
  model: null,
};

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      columns: Array.isArray(parsed.columns) ? (parsed.columns as ColumnKey[]) : DEFAULT_PREFS.columns,
      columnWidths:
        parsed.columnWidths && typeof parsed.columnWidths === "object"
          ? (parsed.columnWidths as ColumnWidths)
          : {},
      windowDays:
        typeof parsed.windowDays === "number" && parsed.windowDays > 0
          ? Math.round(parsed.windowDays)
          : null,
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
