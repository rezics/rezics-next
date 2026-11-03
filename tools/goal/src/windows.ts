import { defaultPolicy, type ControlPolicy } from './policy.ts';
import { spawnSync } from 'node:child_process';

export type WindowSettings = { policy?: ControlPolicy['windows'] | undefined; socket: string; session: string; tmuxCommand?: string; termspacesCommand?: string };
export type WindowRunner = (executable: string, argv: string[]) => string;
const run = (executable: string, argv: string[], policy = defaultPolicy.windows): string => {
  const result = spawnSync(executable, argv, { encoding: 'utf8', timeout: policy.commandTimeoutMs });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || `${executable} failed`).trim());
  return result.stdout.trim();
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const UNAVAILABLE_CODES = new Set([
  'ETIMEDOUT',
  'EACCES',
  'EPERM',
  'ECONNRESET',
  'EPIPE',
  'ECONNREFUSED',
  'ENOTCONN',
  'EAGAIN',
  'EIO',
  'ENOENT',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);
const errorCode = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code != null ? String(error.code) : undefined;
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error)).trim();
const isUnavailableObservation = (error: unknown) => {
  const code = errorCode(error);
  return (
    (code !== undefined && UNAVAILABLE_CODES.has(code)) ||
    /ETIMEDOUT|EACCES|EPERM|ECONNRESET|EPIPE|ECONNREFUSED|ENOENT|permission denied|timed? ?out|connection reset|broken pipe|connection refused/i.test(
      errorMessage(error),
    )
  );
};
const isAbsentWindowObservation = (error: unknown) =>
  !isUnavailableObservation(error) &&
  /no server running|can'?t find (?:session|window)|\(No such file or directory\)/i.test(errorMessage(error));
const unavailableWindowStatus = (error: unknown) => {
  if (error instanceof Error && error.message.startsWith('window status unavailable:')) return error;
  const message = errorMessage(error);
  const code = errorCode(error);
  return new Error(`window status unavailable: ${code && !message.includes(code) ? `${code}: ${message}` : message}`, {
    cause: error instanceof Error ? error : undefined,
  });
};

export interface ManagerWindows {
  register(manager: string, argv: string[], cwd: string): string;
  unregister(manager: string): void;
  /** False when the manager's window is gone or its process has exited. Observation failures throw. */
  alive?(manager: string): boolean;
  /** Run argv in the manager's window again, replacing whatever it holds. */
  respawn?(manager: string, argv: string[], cwd: string): void;
  /** Type a message into the manager's live session and submit it; the session queues it if a turn is running. */
  prompt?(manager: string, text: string): void;
}

/** Resolve termspaces' stable session option; do not inspect or kill unrelated windows. */
export class TermspacesWindows implements ManagerWindows {
  constructor(
    private readonly settings: WindowSettings,
    private readonly execute: WindowRunner = (executable, argv) => run(executable, argv, settings.policy),
  ) {}
  private tmux(argv: string[]): string {
    return this.execute(this.settings.tmuxCommand ?? 'tmux', ['-S', this.settings.socket, ...argv]);
  }
  private observe<T>(read: () => T): T | undefined {
    try {
      return read();
    } catch (error) {
      if (isAbsentWindowObservation(error)) return undefined;
      throw unavailableWindowStatus(error);
    }
  }
  private lookupSession(): string | undefined {
    return this.observe(
      () =>
        this.tmux(['list-sessions', '-F', '#{session_id}\t#{session_name}\t#{@ts-session-id}'])
          .split('\n')
          .map((line) => line.split('\t'))
          .find(([, name, id]) => name === this.settings.session || id === this.settings.session)?.[0],
    );
  }
  private session(): string {
    let session = this.lookupSession();
    if (!session) {
      this.execute(this.settings.termspacesCommand ?? 'termspaces', ['--socket-path', this.settings.socket, 'apply']);
      session = this.lookupSession();
    }
    if (!session) throw new Error(`Missing termspaces session: ${this.settings.session}`);
    return session;
  }
  register(manager: string, argv: string[], cwd: string): string {
    const session = this.session();
    const existing = this.find(session, manager);
    if (existing) return existing;
    const id = this.tmux([
      'new-window',
      '-d',
      '-P',
      '-F',
      '#{window_id}',
      '-t',
      `${session}:`,
      '-n',
      `goal-${manager}`,
      '-c',
      cwd,
      argv.map(quote).join(' '),
    ]);
    try {
      this.tmux(['set-option', '-w', '-t', id, '@goal-manager', manager]);
    } catch (error) {
      this.tmux(['kill-window', '-t', id]);
      throw error;
    }
    return id;
  }
  private find(session: string, manager: string): string | undefined {
    return this.observe(
      () =>
        this.tmux(['list-windows', '-t', session, '-F', '#{window_id}\t#{@goal-manager}'])
          .split('\n')
          .map((line) => line.split('\t'))
          .find(([, owner]) => owner === manager)?.[0],
    );
  }
  alive(manager: string): boolean {
    const session = this.lookupSession();
    if (!session) return false;
    return (
      this.observe(() =>
        this.tmux(['list-windows', '-t', session, '-F', '#{@goal-manager}\t#{pane_dead}'])
          .split('\n')
          .map((line) => line.split('\t'))
          .some(([owner, dead]) => owner === manager && dead === '0'),
      ) === true
    );
  }
  respawn(manager: string, argv: string[], cwd: string): void {
    const id = this.find(this.session(), manager);
    if (!id) {
      this.register(manager, argv, cwd);
      return;
    }
    this.tmux(['respawn-pane', '-k', '-t', id, '-c', cwd, argv.map(quote).join(' ')]);
  }
  prompt(manager: string, text: string): void {
    const id = this.find(this.session(), manager);
    if (!id) throw new Error(`Missing manager window: ${manager}`);
    this.tmux(['send-keys', '-t', id, '-l', text.replace(/[\r\n]+/g, ' ')]);
    this.tmux(['send-keys', '-t', id, 'Enter']);
  }
  unregister(manager: string): void {
    const session = this.lookupSession();
    if (!session) return;
    const id = this.find(session, manager);
    if (id) this.tmux(['kill-window', '-t', id]);
  }
}
