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
      const marker = `[resident inbox ${actionable[0]!.id}-${last}]`;
      const summaryLimit = Math.min(1200, Math.floor(10000 / actionable.length));
      const details = actionable
        .map(
          ({ id, event }) =>
            `#${id} ${event.kind}${event.from ? ` from ${event.from.slice(0, 80)}` : ''}: ${event.summary.replace(/\s+/g, ' ').slice(0, summaryLimit)}`,
        )
        .join(' | ');
      this.send(
        resident,
        `${marker} ${details} Act on these events now; inspect the native inbox and task store as needed. For a low-output hourly report, diagnose the largest loss, act within the hour and report cause and action to the project Telegram group. ${marker}`,
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
export function tmuxResidentSender(socket: string, pane: string, command = 'tmux') {
  const run = (...args: string[]) => {
    const result = spawnSync(command, ['-S', socket, ...args], { encoding: 'utf8', timeout: 5000 });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`tmux ${args[0]} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
    return result.stdout.trim();
  };
  return (resident: ResidentIdentity, prompt: string): void => {
    const current = run('display-message', '-p', '-t', pane, '#{pane_current_command}');
    if (current !== resident.provider)
      throw new Error(`Resident pane ${pane} runs ${current}, expected ${resident.provider} (${resident.threadId})`);
    run('send-keys', '-t', pane, '-l', prompt);
    const marker = prompt.slice(0, prompt.indexOf(']') + 1);
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
    run('send-keys', '-t', pane, 'Enter');
  };
}
