import type { Database } from 'bun:sqlite';
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { ManagerEvent } from './contracts.ts';
import { quietDelivery, residentInboxCursor } from './inbox.ts';

export type ResidentIdentity = { id: string; provider: 'codex' | 'claude'; threadId: string };
type WakeRow = { id: number; event: string; created_at: number };

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

export type ResidentActivity = { state: 'unknown' | 'busy' | 'idle'; since: number };

/** Codex lifecycle events describe turns; silence and background tool completions do not describe idleness. */
export class CodexResidentActivity {
  private offset = 0;
  private partial = '';
  private decoder = new StringDecoder('utf8');
  private fileIdentity = '';
  private sessionId: string | undefined;
  private malformed = false;
  private turnId: string | undefined;
  private activity: ResidentActivity = { state: 'unknown', since: 0 };
  constructor(private readonly path: string) {}
  read(resident: ResidentIdentity): ResidentActivity {
    if (resident.provider !== 'codex') return { state: 'unknown', since: 0 };
    const fd = openSync(this.path, 'r');
    try {
      const stat = fstatSync(fd);
      const identity = `${stat.dev}:${stat.ino}`;
      if (identity !== this.fileIdentity || stat.size < this.offset) {
        this.offset = 0;
        this.partial = '';
        this.decoder = new StringDecoder('utf8');
        this.sessionId = undefined;
        this.malformed = false;
        this.turnId = undefined;
        this.activity = { state: 'unknown', since: 0 };
        this.fileIdentity = identity;
      }
      const buffer = Buffer.alloc(64 * 1024);
      while (this.offset < stat.size) {
        const count = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - this.offset), this.offset);
        if (!count) break;
        this.offset += count;
        this.partial += this.decoder.write(buffer.subarray(0, count));
        let end: number;
        while ((end = this.partial.indexOf('\n')) >= 0) {
          const line = this.partial.slice(0, end);
          this.partial = this.partial.slice(end + 1);
          if (!line.trim()) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            this.malformed = true;
            continue;
          }
          if (event.type === 'session_meta') this.sessionId = event.payload?.id;
          if (event.type !== 'event_msg') continue;
          const payload = event.payload;
          const since = Date.parse(event.timestamp);
          if (!payload || typeof payload.turn_id !== 'string' || !Number.isFinite(since)) continue;
          if (payload.type === 'task_started') {
            this.turnId = payload.turn_id;
            this.activity = { state: 'busy', since };
          } else if (['task_complete', 'turn_aborted'].includes(payload.type) && payload.turn_id === this.turnId) {
            this.activity = { state: 'idle', since };
          }
        }
      }
      if (this.sessionId !== resident.threadId)
        throw new Error('Resident transcript does not match the registered Codex session');
      return this.malformed || this.partial.length ? { state: 'unknown', since: 0 } : this.activity;
    } finally {
      closeSync(fd);
    }
  }
}

type OutstandingWake = { first: number; through: number; threadId: string; submitted: boolean };
export class ResidentWakeBridge {
  private outstanding: OutstandingWake | undefined;
  constructor(
    private readonly db: Database,
    private readonly manager: string,
    private readonly cursorFile: string,
    private readonly send: (resident: ResidentIdentity, prompt: string) => void,
    private readonly startAfter: number | undefined,
    private readonly activity: (resident: ResidentIdentity) => ResidentActivity,
    private readonly now: () => number = Date.now,
  ) {
    if (existsSync(cursorFile)) {
      const cursor = JSON.parse(readFileSync(cursorFile, 'utf8'));
      if (cursor.manager !== manager) throw new Error(`Invalid resident wake cursor: ${cursorFile}`);
      // Older transport checkpoints were never personal read receipts.
      this.outstanding = cursor.outstanding;
      if (
        this.outstanding &&
        (!Number.isSafeInteger(this.outstanding.first) || !Number.isSafeInteger(this.outstanding.through))
      )
        throw new Error(`Invalid resident wake cursor: ${cursorFile}`);
    }
  }
  private checkpoint(): void {
    mkdirSync(dirname(this.cursorFile), { recursive: true });
    const temporary = `${this.cursorFile}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ manager: this.manager, outstanding: this.outstanding }));
    renameSync(temporary, this.cursorFile);
  }
  flush(): number {
    const resident = residentIdentity(this.db, this.manager);
    const after = residentInboxCursor(this.db, this.manager) ?? this.startAfter;
    if (after === undefined) throw new Error('Resident inbox has no personal receipt; provide explicit --start-after');
    const rows = this.db
      .query(`SELECT id, event, created_at FROM manager_inbox
      WHERE manager = ? AND id > ? AND wakeable = 1 AND quiet = 0 ORDER BY id`)
      .all(this.manager, after) as WakeRow[];
    const actionable = rows.filter((row) => residentWakeable(JSON.parse(row.event) as ManagerEvent));
    const first = actionable[0];
    const last = actionable.at(-1);
    if (
      this.outstanding &&
      (this.outstanding.threadId !== resident.threadId || after >= this.outstanding.first || !first)
    ) {
      this.outstanding = undefined;
      this.checkpoint();
    }
    if (!first || !last) return 0;
    if (this.outstanding?.submitted) {
      if (last.id > this.outstanding.through) {
        this.outstanding.through = last.id;
        this.checkpoint();
      }
      return 0;
    }
    const status = this.activity(resident);
    const now = this.now();
    if (now - first.created_at < 60_000 || status.state !== 'idle' || now - status.since < 10_000) return 0;
    this.outstanding ??= { first: first.id, through: last.id, threadId: resident.threadId, submitted: false };
    this.outstanding.through = last.id;
    this.checkpoint();
    this.send(
      resident,
      `[resident inbox ${this.outstanding.first}] Unread mail is waiting. Read your native manager inbox with the supported Goal commands.`,
    );
    this.outstanding.submitted = true;
    this.checkpoint();
    return actionable.length;
  }
}

/** Verify the configured pane is running the registered provider and contains the literal prompt before submitting. */
export function tmuxResidentSender(
  socket: string,
  pane: string,
  command = 'tmux',
  journalFile?: string,
  consumedThrough?: () => number | undefined,
) {
  const run = (...args: string[]) => {
    const result = spawnSync(command, ['-S', socket, ...args], { encoding: 'utf8', timeout: 5000 });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`tmux ${args[0]} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
    return result.stdout.trim();
  };
  let staged: { threadId: string; marker: string; submitted: boolean } | undefined =
    journalFile && existsSync(journalFile) ? JSON.parse(readFileSync(journalFile, 'utf8')) : undefined;
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
      if (staged.marker !== marker && !staged.submitted) {
        const oldId = /^\[resident inbox (\d+)\]$/.exec(staged.marker)?.[1];
        // An owner's real read retires obsolete staged input; transport retries alone never do.
        if (!oldId || (consumedThrough?.() ?? -1) < Number(oldId))
          throw new Error(`Resident pane ${pane} still has an unconfirmed delivery ${staged.marker}`);
      }
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
    // Commit before Enter: a crash in an uncertain submission must never submit the same input twice.
    staged = { threadId: resident.threadId, marker, submitted: true };
    checkpoint();
    run('send-keys', '-t', pane, 'Enter');
  };
}
