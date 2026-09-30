import type { Change } from './types.ts';

/** One changed fact: a readable path, the language it is in, and the value before and after (null when absent). */
export interface Leaf { key: string; path: string[]; language: string | null; before: string | null; after: string | null }

type Json = unknown;
const isRecord = (value: Json): value is Record<string, Json> => typeof value === 'object' && value !== null
  && !Array.isArray(value);

/** Rows that name their language (`{ language: 'en', ... }`) are matched by it, not by position. */
const byLanguage = (rows: readonly Json[]): Map<string, Json> | null => {
  const entries = rows.map(row => isRecord(row) && typeof row.language === 'string' ? [row.language, row] as const : null);
  return entries.every(entry => entry !== null) ? new Map(entries) : null;
};

const scalar = (value: Json): string | null => value === null || value === undefined ? null
  : typeof value === 'string' ? value : JSON.stringify(value);

function walk(path: string[], language: string | null, before: Json, after: Json, out: Leaf[]) {
  if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) return;
  if (Array.isArray(before) || Array.isArray(after)) {
    const left = Array.isArray(before) ? before : [], right = Array.isArray(after) ? after : [];
    const keyedLeft = byLanguage(left), keyedRight = byLanguage(right);
    if (keyedLeft && keyedRight) {
      for (const tag of [...new Set([...keyedLeft.keys(), ...keyedRight.keys()])].sort()) {
        walk(path, tag, keyedLeft.get(tag) ?? null, keyedRight.get(tag) ?? null, out);
      }
      return;
    }
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      walk([...path, String(index + 1)], language, left[index] ?? null, right[index] ?? null, out);
    }
    return;
  }
  if (isRecord(before) || isRecord(after)) {
    const left = isRecord(before) ? before : {}, right = isRecord(after) ? after : {};
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      if (key === 'language' && language !== null) continue;
      walk([...path, key], language, left[key] ?? null, right[key] ?? null, out);
    }
    return;
  }
  out.push({ key: `${language ?? ''}:${path.join('.')}`, path, language, before: scalar(before), after: scalar(after) });
}

/**
 * The preview Main returns, one changed fact at a time: a Work's header changes
 * as `localized` rows matched by language, so a synopsis edit reads as that
 * language's `description` from one text to another. Only facts that differ appear.
 */
export function leaves(changes: readonly Change[]): Leaf[] {
  const out: Leaf[] = [];
  for (const change of changes) walk([change.path], null, change.before, change.after, out);
  return out;
}
