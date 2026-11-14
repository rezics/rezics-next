import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';

/** A note in local configuration; `manager-duty:` in text opts into native delivery to active manager sessions. */
export type Note = { text: string; remindAt?: string; everyHours?: number };

export type ManagerDutySession = {
  id: string;
  status?: unknown;
  kind?: unknown;
  goalStatus?: unknown;
  activeTurnId?: unknown;
  waitingForInbox?: unknown;
  goalPauseOrigin?: unknown;
};

const managerDutyPrefix = 'manager-duty:';

const hourMs = 3_600_000;
const minimumPeriodMs = 1;

export function parseNotes(value: unknown, label = 'notes'): Note[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label}[${index}] must be an object`);
    const note = raw as Record<string, unknown>;
    for (const key of Object.keys(note))
      if (!['text', 'remindAt', 'everyHours'].includes(key)) throw new Error(`unknown ${label}[${index}].${key}`);
    if (typeof note.text !== 'string' || !note.text.trim()) throw new Error(`${label}[${index}].text is required`);
    if (
      note.remindAt !== undefined &&
      (typeof note.remindAt !== 'string' || !Number.isFinite(Date.parse(note.remindAt)))
    )
      throw new Error(`${label}[${index}].remindAt must be an ISO time`);
    if (note.everyHours !== undefined && (typeof note.everyHours !== 'number' || !(note.everyHours > 0)))
      throw new Error(`${label}[${index}].everyHours must be a positive number`);
    if (note.everyHours !== undefined) {
      const periodMs = note.everyHours * hourMs;
      if (!Number.isFinite(periodMs) || periodMs < minimumPeriodMs)
        throw new Error(`${label}[${index}].everyHours must resolve to at least one millisecond`);
    }
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
  if (!Number.isFinite(first) || !Number.isFinite(now) || first > now) return undefined;
  if (!note.everyHours) return new Date(first).toISOString();
  const period = note.everyHours * hourMs;
  if (!Number.isFinite(period) || period < minimumPeriodMs) return undefined;
  let latest = first + Math.floor((now - first) / period) * period;
  if (latest > now) latest -= period;
  if (latest < first) latest = first;
  const date = new Date(latest);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function isRecordedOccurrence(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function readDeliveryJournal(path: string): Record<string, string> {
  const delivered = Object.create(null) as Record<string, string>;
  try {
    const state: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state)) return delivered;
    for (const [text, value] of Object.entries(state)) if (isRecordedOccurrence(value)) delivered[text] = value;
  } catch {
    /* A damaged record delivers again rather than never. */
  }
  return delivered;
}

/** Read just the persisted manager fields needed to decide who should receive a recurring duty note. */
export function readManagerDutySessions(db: Database): ManagerDutySession[] {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manager_sessions'").get()) return [];
  return (db.query('SELECT id, state FROM manager_sessions').all() as { id: string; state: string }[]).flatMap(
    ({ id, state }) => {
      try {
        const parsed: unknown = JSON.parse(state);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
        const session = parsed as Record<string, unknown>;
        const goalState = session.goalState;
        const goalStatus =
          goalState && typeof goalState === 'object' && !Array.isArray(goalState)
            ? (goalState as Record<string, unknown>).status
            : undefined;
        return [
          {
            id,
            status: session.status,
            kind: session.kind,
            goalStatus,
            activeTurnId: session.activeTurnId,
            waitingForInbox: session.waitingForInbox,
            goalPauseOrigin: session.goalPauseOrigin,
          },
        ];
      } catch {
        return [];
      }
    },
  );
}

function dutyJournalKey(text: string, recipient: string): string {
  return `manager-duty:${JSON.stringify([recipient, text])}`;
}

function managerDutySessionIsEligible(session: ManagerDutySession): boolean {
  if (session.status !== 'running') return false;
  if (session.goalStatus === undefined || session.goalStatus === null || session.goalStatus === 'active') return true;
  return session.goalStatus === 'paused' && session.waitingForInbox === true && session.goalPauseOrigin === 'automatic';
}

/** Resolve the resident and currently active managed sessions, including inbox-parked sessions. */
export function managerDutyRecipients(supermanager: string, sessions: readonly ManagerDutySession[]): string[] {
  const resident = sessions.find((session) => session.id === supermanager);
  const recipients = sessions
    .filter((session) => session.id !== supermanager && session.kind !== 'resident-supermanager')
    .filter(managerDutySessionIsEligible)
    .map((session) => session.id);
  if (!resident || managerDutySessionIsEligible(resident)) recipients.push(supermanager);
  return [...new Set(recipients)].sort((left, right) => left.localeCompare(right));
}

/** Deliver each due reminder once per occurrence; duty notes are additionally keyed by recipient. */
export function deliverDueReminders(
  notes: readonly Note[],
  stateDirectory: string,
  deliver: (summary: string, recipient?: string) => void,
  now = Date.now(),
  dutyRecipients: readonly string[] = [],
): number {
  const path = join(stateDirectory, 'note-reminders.json');
  const delivered = existsSync(path) ? readDeliveryJournal(path) : (Object.create(null) as Record<string, string>);
  let count = 0;
  for (const note of notes) {
    const at = occurrence(note, now);
    if (!at) continue;
    if (note.text.startsWith(managerDutyPrefix)) {
      const instructions = note.text.slice(managerDutyPrefix.length).trim();
      for (const recipient of dutyRecipients) {
        const key = dutyJournalKey(note.text, recipient);
        if (delivered[key] === at) continue;
        try {
          deliver(
            `Manager duty (local configuration note, due ${at}): ${instructions}`.replace(/[\r\n]+/g, ' '),
            recipient,
          );
          delivered[key] = at;
          count++;
        } catch {
          // A failed recipient retries on the next sweep without holding the other managers back.
        }
      }
      continue;
    }
    if (delivered[note.text] === at) continue;
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
