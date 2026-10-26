import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A note in the local configuration. Without remindAt it only documents an arrangement; with remindAt the manager
 * host delivers it to the supermanager once that time passes, and again every everyHours when that is set, so a plan
 * such as using an allowance before its weekly reset is not forgotten.
 */
export type Note = { text: string; remindAt?: string; everyHours?: number };

export function parseNotes(value: unknown, label = 'notes'): Note[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label}[${index}] must be an object`);
    const note = raw as Record<string, unknown>;
    for (const key of Object.keys(note))
      if (!['text', 'remindAt', 'everyHours'].includes(key)) throw new Error(`unknown ${label}[${index}].${key}`);
    if (typeof note.text !== 'string' || !note.text.trim()) throw new Error(`${label}[${index}].text is required`);
    if (note.remindAt !== undefined && (typeof note.remindAt !== 'string' || !Number.isFinite(Date.parse(note.remindAt))))
      throw new Error(`${label}[${index}].remindAt must be an ISO time`);
    if (note.everyHours !== undefined && (typeof note.everyHours !== 'number' || !(note.everyHours > 0)))
      throw new Error(`${label}[${index}].everyHours must be a positive number`);
    if (note.everyHours !== undefined && note.remindAt === undefined)
      throw new Error(`${label}[${index}].everyHours needs remindAt`);
    return {
      text: note.text,
      ...(note.remindAt !== undefined ? { remindAt: note.remindAt as string } : {}),
      ...(note.everyHours !== undefined ? { everyHours: note.everyHours as number } : {}),
    };
  });
}

/** The latest reminder time at or before now, or undefined when the note is not due. */
export function occurrence(note: Note, now: number): string | undefined {
  if (!note.remindAt) return undefined;
  const first = Date.parse(note.remindAt);
  if (first > now) return undefined;
  if (!note.everyHours) return new Date(first).toISOString();
  const period = note.everyHours * 3_600_000;
  return new Date(first + Math.floor((now - first) / period) * period).toISOString();
}

/** Deliver each due reminder once per occurrence; returns how many were delivered. */
export function deliverDueReminders(
  notes: readonly Note[],
  stateDirectory: string,
  deliver: (summary: string) => void,
  now = Date.now(),
): number {
  const path = join(stateDirectory, 'note-reminders.json');
  let delivered: Record<string, string> = {};
  try {
    if (existsSync(path)) delivered = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
  } catch {
    /* A damaged record delivers again rather than never. */
  }
  let count = 0;
  for (const note of notes) {
    const at = occurrence(note, now);
    if (!at || delivered[note.text] === at) continue;
    deliver(`Reminder (local configuration note, due ${at}): ${note.text}`.replace(/[\r\n]+/g, ' '));
    delivered[note.text] = at;
    count++;
  }
  if (count) {
    writeFileSync(`${path}.tmp`, JSON.stringify(delivered, null, 2));
    renameSync(`${path}.tmp`, path);
  }
  return count;
}
