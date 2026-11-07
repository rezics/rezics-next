import type { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ManagerEvent } from './contracts.ts';
import { quietDelivery } from './inbox.ts';

export type ResidentIdentity = { id: string; provider: 'codex' | 'claude'; threadId: string };
type WakeRow = { id: number; event: string };

/** External resident delivery is independent of inbox read, acknowledgement and host notification state. */
export function residentIdentity(db: Database, manager: string): ResidentIdentity {
  const row = db.query('SELECT state FROM manager_sessions WHERE id = ?').get(manager) as { state: string } | null;
  const state = row ? JSON.parse(row.state) : null;
  if (
    state?.kind !== 'resident-supermanager' ||
    state.status !== 'running' ||
    !['codex', 'claude'].includes(state.provider) ||
    typeof state.threadId !== 'string' ||
    !state.threadId
  )
    throw new Error(`No running resident supermanager registered for ${manager}`);
  return { id: manager, provider: state.provider, threadId: state.threadId };
}

export function residentWakeable(event: ManagerEvent): boolean {
  if (quietDelivery(event)) return false;
  // Successful automatic continuation is routine; failures and requests still require a decision.
  return !(
    event.kind === 'environment' && /^Manager \S+ renewed after using \d+ tokens; new thread \S+\.$/.test(event.summary)
  );
}

export class ResidentWakeBridge {
  private after: number;
  constructor(
    private readonly db: Database,
    private readonly manager: string,
    private readonly cursorFile: string,
    private readonly send: (resident: ResidentIdentity, prompt: string) => void,
    startAfter = 0,
  ) {
    this.after = startAfter;
    if (existsSync(cursorFile)) {
      const cursor = JSON.parse(readFileSync(cursorFile, 'utf8'));
      if (cursor.manager !== manager || !Number.isSafeInteger(cursor.after) || cursor.after < 0)
        throw new Error(`Invalid resident wake cursor: ${cursorFile}`);
      this.after = cursor.after;
    }
  }
  flush(): number {
    const resident = residentIdentity(this.db, this.manager);
    const rows = this.db
      .query('SELECT id, event FROM manager_inbox WHERE manager = ? AND id > ? AND wakeable = 1 ORDER BY id LIMIT 100')
      .all(this.manager, this.after) as WakeRow[];
    if (!rows.length) return 0;
    const actionable = rows
      .map((row) => ({ id: row.id, event: JSON.parse(row.event) as ManagerEvent }))
      .filter((row) => residentWakeable(row.event));
    const last = rows[rows.length - 1]!.id;
    if (actionable.length) {
      // Keep the marker stable while new events arrive during a transport retry.
      // The inbox owns event bodies; large terminal pastes can hide their markers.
      const marker = `[resident inbox ${actionable[0]!.id}]`;
      const kinds = [...new Set(actionable.map(({ event }) => event.kind))].join(', ');
      this.send(
        resident,
        `${marker} ${actionable.length} new events (${kinds}) through #${last}. Read the supermanager inbox with the supported Goal commands and act on the pending decisions and alarms.`,
      );
    }
    // Never consume native inbox state. Failed delivery throws before this independent checkpoint.
    mkdirSync(dirname(this.cursorFile), { recursive: true });
    const temporary = `${this.cursorFile}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ manager: this.manager, after: last, resident }));
    renameSync(temporary, this.cursorFile);
    this.after = last;
    return actionable.length;
  }
}

/** Verify the configured pane is running the registered provider and contains the literal prompt before submitting. */
export function tmuxResidentSender(socket: string, pane: string, command = 'tmux', journalFile?: string) {
  const run = (...args: string[]) => {
    const result = spawnSync(command, ['-S', socket, ...args], { encoding: 'utf8', timeout: 5000 });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`tmux ${args[0]} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
    return result.stdout.trim();
  };
  let staged: { threadId: string; marker: string; submitted: boolean } | undefined = journalFile && existsSync(journalFile)
    ? JSON.parse(readFileSync(journalFile, 'utf8'))
    : undefined;
  const checkpoint = () => {
    if (!journalFile) return;
    mkdirSync(dirname(journalFile), { recursive: true });
    const temporary = `${journalFile}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(staged));
    renameSync(temporary, journalFile);
  };
  return (resident: ResidentIdentity, prompt: string): void => {
    const current = run('display-message', '-p', '-t', pane, '#{pane_current_command}');
    if (current !== resident.provider)
      throw new Error(`Resident pane ${pane} runs ${current}, expected ${resident.provider} (${resident.threadId})`);
    const marker = prompt.slice(0, prompt.indexOf(']') + 1);
    if (!marker) throw new Error('Resident prompt is missing a delivery marker');
    if (staged?.threadId === resident.threadId) {
      if (staged.marker !== marker && !staged.submitted)
        throw new Error(`Resident pane ${pane} still has an unconfirmed delivery ${staged.marker}`);
      if (staged.marker === marker && staged.submitted) return;
    }
    const retry = staged?.threadId === resident.threadId && staged.marker === marker;
    if (!retry) {
      // Record before writing: a failed display check or process restart must never
      // append the same text to the resident's draft again.
      staged = { threadId: resident.threadId, marker, submitted: false };
      checkpoint();
      run('send-keys', '-t', pane, '-l', prompt);
    }
    let displayed = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const captured = run('capture-pane', '-p', '-t', pane, '-S', '-100').replace(/\n/g, '');
      if (captured.includes(marker)) {
        displayed = true;
        break;
      }
      Bun.sleepSync(50);
    }
    if (!displayed) throw new Error(`Resident pane ${pane} did not display delivery marker ${marker}`);
    // Give the CLI time to finish processing the paste before submitting it.
    Bun.sleepSync(250);
    run('send-keys', '-t', pane, 'Enter');
    staged = { threadId: resident.threadId, marker, submitted: true };
    checkpoint();
  };
}
