import { defaultPolicy, type ControlPolicy } from './policy.ts';
import { runHostProcess } from './process.ts';

export type WindowSettings = {
  policy?: ControlPolicy['windows'] | undefined;
  socket: string;
  session: string;
  tmuxCommand?: string;
  termspacesCommand?: string;
};
export type WindowRunner = (executable: string, argv: string[]) => string | Promise<string>;
const run = async (executable: string, argv: string[], policy = defaultPolicy.windows): Promise<string> => {
  const result = await runHostProcess(executable, argv, { timeoutMs: policy.commandTimeoutMs });
  if (result.code !== 0) throw new Error((result.stderr || `${executable} failed`).trim());
  return result.stdout.trim();
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/** tmux 3.7c with no locale replaces unprintable `-F` tabs with underscores. */
function tmuxFields(line: string): string[] {
  if (line.includes('\t')) return line.split('\t');
  const session = line.match(/^(\$\d+)_(.*)_(.*)$/);
  if (session) return [session[1]!, session[2]!, session[3]!];
  const window = line.match(/^(@\d+)_(.*)$/);
  if (window) return [window[1]!, window[2]!];
  const dead = line.match(/^(.*)_([01])$/);
  if (dead) return [dead[1]!, dead[2]!];
  return [line];
}
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
  register(manager: string, argv: string[], cwd: string): string | Promise<string>;
  unregister(manager: string): void | Promise<void>;
  /** False when the manager's window is gone or its process has exited. Observation failures throw. */
  alive?(manager: string): boolean | Promise<boolean>;
  /** Run argv in the manager's window again, replacing whatever it holds. */
  respawn?(manager: string, argv: string[], cwd: string): void | Promise<void>;
  /** Type a message into the manager's live session and submit it; the session queues it if a turn is running. */
  prompt?(manager: string, text: string): void | Promise<void>;
}

/** Resolve termspaces' stable session option; do not inspect or kill unrelated windows. */
export class TermspacesWindows implements ManagerWindows {
  constructor(
    private readonly settings: WindowSettings,
    private readonly execute: WindowRunner = (executable, argv) => run(executable, argv, settings.policy),
  ) {}
  private tmux(argv: string[]): Promise<string> {
    return Promise.resolve(
      this.execute(this.settings.tmuxCommand ?? 'tmux', ['-u', '-S', this.settings.socket, ...argv]),
    );
  }
  private async observe<T>(read: () => Promise<T>): Promise<T | undefined> {
    try {
      return await read();
    } catch (error) {
      if (isAbsentWindowObservation(error)) return undefined;
      throw unavailableWindowStatus(error);
    }
  }
  private lookupSession(): Promise<string | undefined> {
    return this.observe(
      async () =>
        (await this.tmux(['list-sessions', '-F', '#{session_id}\t#{session_name}\t#{@ts-session-id}']))
          .split('\n')
          .map(tmuxFields)
          .find(([, name, id]) => name === this.settings.session || id === this.settings.session)?.[0],
    );
  }
  private async session(): Promise<string> {
    let session = await this.lookupSession();
    if (!session) {
      await this.execute(this.settings.termspacesCommand ?? 'termspaces', [
        '--socket-path',
        this.settings.socket,
        'apply',
      ]);
      session = await this.lookupSession();
    }
    if (!session) throw new Error(`Missing termspaces session: ${this.settings.session}`);
    return session;
  }
  async register(manager: string, argv: string[], cwd: string): Promise<string> {
    const session = await this.session();
    const existing = await this.find(session, manager);
    if (existing) return existing;
    const id = await this.tmux([
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
      await this.tmux(['set-option', '-w', '-t', id, '@goal-manager', manager]);
    } catch (error) {
      await this.tmux(['kill-window', '-t', id]);
      throw error;
    }
    return id;
  }
  private find(session: string, manager: string): Promise<string | undefined> {
    return this.observe(
      async () =>
        (await this.tmux(['list-windows', '-t', session, '-F', '#{window_id}\t#{@goal-manager}']))
          .split('\n')
          .map(tmuxFields)
          .find(([, owner]) => owner === manager)?.[0],
    );
  }
  async alive(manager: string): Promise<boolean> {
    const session = await this.lookupSession();
    if (!session) return false;
    return (
      (await this.observe(async () =>
        (await this.tmux(['list-windows', '-t', session, '-F', '#{@goal-manager}\t#{pane_dead}']))
          .split('\n')
          .map(tmuxFields)
          .some(([owner, dead]) => owner === manager && dead === '0'),
      )) === true
    );
  }
  async respawn(manager: string, argv: string[], cwd: string): Promise<void> {
    const id = await this.find(await this.session(), manager);
    if (!id) {
      await this.register(manager, argv, cwd);
      return;
    }
    await this.tmux(['respawn-pane', '-k', '-t', id, '-c', cwd, argv.map(quote).join(' ')]);
  }
  async prompt(manager: string, text: string): Promise<void> {
    const id = await this.find(await this.session(), manager);
    if (!id) throw new Error(`Missing manager window: ${manager}`);
    await this.tmux(['send-keys', '-t', id, '-l', text.replace(/[\r\n]+/g, ' ')]);
    await this.tmux(['send-keys', '-t', id, 'Enter']);
  }
  async unregister(manager: string): Promise<void> {
    const session = await this.lookupSession();
    if (!session) return;
    const id = await this.find(session, manager);
    if (id) await this.tmux(['kill-window', '-t', id]);
  }
}
