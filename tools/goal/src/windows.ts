import { defaultPolicy, type ControlPolicy } from './policy.ts';
import { runHostProcess } from './process.ts';
import { resolve } from 'node:path';

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
const command = (argv: string[]) => argv.map(quote).join(' ');
function unwrapTmuxCommand(value: string): string | undefined {
  const command = value.trim();
  if (!command.startsWith('"') || !command.endsWith('"')) return command;
  let unwrapped = '';
  for (let index = 1; index < command.length - 1; index += 1) {
    const character = command[index]!;
    if (character === '"') return undefined;
    if (character === '\\') {
      const next = command[++index];
      if (next === undefined) return undefined;
      unwrapped += next === '"' || next === '\\' || next === '$' || next === '`' ? next : `\\${next}`;
    } else unwrapped += character;
  }
  return unwrapped;
}
function shellArgv(value: string): string[] | undefined {
  const source = unwrapTmuxCommand(value);
  if (source === undefined) return undefined;
  const argv: string[] = [];
  let token = '';
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote === "'") {
      if (character === "'") quote = undefined;
      else token += character;
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = undefined;
        continue;
      }
      if (character === '$' || character === '`') return undefined;
      if (character === '\\') {
        const next = source[index + 1];
        if (next === undefined) return undefined;
        if (next === '$' || next === '`' || next === '"' || next === '\\' || next === '\n') {
          index += 1;
          if (next !== '\n') token += next;
        } else token += character;
        continue;
      }
      token += character;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        argv.push(token);
        token = '';
        started = false;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (character === '$' || character === '`' || /[;&|<>()*?\[\]#]/.test(character)) return undefined;
    if (character === '\\') {
      const next = source[++index];
      if (next === undefined) return undefined;
      token += next;
    } else token += character;
    started = true;
  }
  if (quote !== undefined) return undefined;
  if (started) argv.push(token);
  return argv;
}
// Keep a terminal owner around the Codex process. The thread is owned by the app-server, not this shell.
const viewerShell = [
  '/bin/sh',
  '-c',
  "trap ':' INT; \"$@\"; trap - INT; printf '\\n[Goal viewer exited; manager thread is unchanged. This terminal is still open.]\\n'; exec \"${SHELL:-/bin/sh}\" -l",
  'goal-codex-viewer',
];

function viewerArgv(value: string): string[] | undefined {
  const observed = shellArgv(value);
  if (observed && viewerShell.every((word, index) => observed[index] === word)) return observed.slice(viewerShell.length);
  return observed;
}

function viewerCommand(argv: string[], manager: string): string {
  return command(isCodexViewer(argv, manager) ? [...viewerShell, ...argv] : argv);
}

function differsOnlyByRemoteEndpoint(current: string, argv: string[]): boolean {
  const observed = viewerArgv(current);
  const remote = argv.indexOf('--remote');
  if (
    !observed ||
    remote < 0 ||
    remote !== argv.lastIndexOf('--remote') ||
    !argv[remote + 1] ||
    observed.length !== argv.length ||
    observed[remote] !== '--remote' ||
    !observed[remote + 1] ||
    observed[remote + 1] === argv[remote + 1]
  )
    return false;
  return argv.every((value, index) => index === remote + 1 || observed[index] === value);
}
function isCodexViewer(argv: string[], manager: string): boolean {
  if (argv[0] !== 'env') return false;
  const environment = new Map<string, string>();
  let index = 1;
  while (index < argv.length) {
    if (argv[index] === '-u') {
      if (!argv[index + 1]) return false;
      index += 2;
      continue;
    }
    const assignment = argv[index]!.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
    if (!assignment) break;
    if (environment.has(assignment[1]!)) return false;
    environment.set(assignment[1]!, assignment[2]!);
    index += 1;
  }
  const [executable, action, threadId, remoteFlag, endpoint, ...extra] = argv.slice(index);
  return (
    environment.get('GOAL_MANAGER') === manager &&
    Boolean(environment.get('CODEX_HOME')) &&
    Boolean(executable) &&
    action === 'resume' &&
    Boolean(threadId) &&
    remoteFlag === '--remote' &&
    Boolean(endpoint) &&
    extra.length === 0
  );
}
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

/** Return only the exact, visible Codex Goal resume menu selection. */
export function pausedGoalMenuSelection(capture: string): 'resume' | 'leave' | undefined {
  const lines = capture.split('\n');
  const heading = lines.findLastIndex((line) => line.includes('Resume paused goal?'));
  if (heading < 0) return;
  const menu = lines.slice(heading, heading + 12);
  const resume = menu.findIndex((line) => /1\. Resume goal[ \t]+Mark it active and continue when idle/.test(line));
  if (
    resume < 1 ||
    !/2\. Leave paused[ \t]+Keep it paused; use \/goal resume later/.test(menu[resume + 1] ?? '') ||
    !menu.slice(resume + 2, resume + 5).some((line) => /enter select[ \t]+·[ \t]+esc back/.test(line))
  )
    return;
  const first = /›[ \t]+1\. Resume goal/.test(menu[resume]!);
  const second = /›[ \t]+2\. Leave paused/.test(menu[resume + 1]!);
  if (first !== second) return first ? 'resume' : 'leave';
}

export interface ManagerWindows {
  register(manager: string, argv: string[], cwd: string): string | Promise<string>;
  unregister(manager: string): void | Promise<void>;
  /** False when the manager's window is gone or its process has exited. Observation failures throw. */
  alive?(manager: string): boolean | Promise<boolean>;
  /** Run argv in the manager's window again, replacing whatever it holds. */
  respawn?(manager: string, argv: string[], cwd: string): void | Promise<void>;
  /** Restore access beside a proven Codex viewer whose endpoint is stale; exited panes require authorization. */
  rebindIfStale?(
    manager: string,
    argv: string[],
    cwd: string,
    options?: { restoreExited?: boolean },
  ): boolean | Promise<boolean>;
  /** Type a message into the manager's live session and submit it; the session queues it if a turn is running. */
  prompt?(manager: string, text: string): void | Promise<void>;
}

/** Resolve termspaces' stable session option; do not inspect or kill unrelated windows. */
export class TermspacesWindows implements ManagerWindows {
  private readonly startupMenuProbes = new Set<string>();
  constructor(
    private readonly settings: WindowSettings,
    private readonly execute: WindowRunner = (executable, argv) => run(executable, argv, settings.policy),
    private readonly deferViewerProbe = (delayMs: number, probe: () => void) => {
      setTimeout(probe, delayMs).unref();
    },
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
    if (existing) {
      if (isCodexViewer(argv, manager)) await this.watchViewerStartup(existing, argv, cwd);
      return existing;
    }
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
      viewerCommand(argv, manager),
    ]);
    try {
      await this.tmux(['set-option', '-w', '-t', id, '@goal-manager', manager]);
    } catch (error) {
      await this.tmux(['kill-window', '-t', id]);
      throw error;
    }
    if (isCodexViewer(argv, manager)) await this.watchViewerStartup(id, argv, cwd);
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
    await this.tmux(['respawn-pane', '-k', '-t', id, '-c', cwd, viewerCommand(argv, manager)]);
    if (isCodexViewer(argv, manager)) await this.watchViewerStartup(id, argv, cwd);
  }
  private async paneIds(window: string): Promise<string[] | undefined> {
    const result = await this.observe(() => this.tmux(['list-panes', '-t', window, '-F', '#{pane_id}']));
    return result?.split('\n').map((pane) => pane.trim()).filter(Boolean);
  }
  private async pane(windowOrPane: string): Promise<{ dead: string; cwd: string; command: string } | undefined> {
    const [dead, cwd, startCommand] = await Promise.all([
      this.observe(() => this.tmux(['display-message', '-p', '-t', windowOrPane, '#{pane_dead}'])),
      this.observe(() => this.tmux(['display-message', '-p', '-t', windowOrPane, '#{pane_current_path}'])),
      this.observe(() => this.tmux(['display-message', '-p', '-t', windowOrPane, '#{pane_start_command}'])),
    ]);
    if (dead === undefined || cwd === undefined || startCommand === undefined) return undefined;
    return { dead: dead.trim(), cwd: cwd.trim(), command: startCommand.trim() };
  }
  private sameViewer(pane: { cwd: string; command: string }, argv: string[], cwd: string): boolean {
    const observed = viewerArgv(pane.command);
    return (
      resolve(pane.cwd) === resolve(cwd) &&
      observed !== undefined &&
      observed.length === argv.length &&
      observed.every((value, index) => value === argv[index])
    );
  }
  async rebindIfStale(
    manager: string,
    argv: string[],
    cwd: string,
    options: { restoreExited?: boolean } = {},
  ): Promise<boolean> {
    if (!isCodexViewer(argv, manager)) return false;
    const session = await this.lookupSession();
    if (!session) return false;
    const id = await this.find(session, manager);
    if (!id) return false;
    const panes = await this.paneIds(id);
    if (!panes?.length) return false;
    const stale: string[] = [];
    let replacement: string | undefined;
    for (const paneId of panes) {
      const observed = await this.pane(paneId);
      if (!observed || resolve(observed.cwd) !== resolve(cwd)) continue;
      if (this.sameViewer(observed, argv, cwd)) {
        // Do not repeatedly start a viewer that already failed on this endpoint.
        if (observed.dead !== '0') return false;
        replacement = paneId;
      } else if (differsOnlyByRemoteEndpoint(observed.command, argv)) {
        if (observed.dead === '0' || (observed.dead === '1' && options.restoreExited)) stale.push(paneId);
      }
    }
    if (!stale.length) {
      if (replacement) this.dismissStartupGoalMenu(id, replacement, argv, cwd);
      return false;
    }
    if (!replacement) {
      replacement = await this.tmux(['split-window', '-d', '-h', '-P', '-F', '#{pane_id}', '-t', id, '-c', cwd, viewerCommand(argv, manager)]);
      if (!/^%\d+$/.test(replacement)) return false;
    }
    for (const paneId of stale) {
      const screen = await this.observe(() => this.tmux(['capture-pane', '-p', '-t', paneId]));
      // Only the plain default prompt positively establishes that there is no visible draft.
      if (screen && /^›[ \t]+Ask Codex to do anything[ \t]*$/m.test(screen) && !pausedGoalMenuSelection(screen)) {
        const tail = screen.split('\n').slice(-12);
        const prompts = tail.filter((line) => /^›/.test(line.trimStart()));
        if (prompts.length === 1 && prompts[0]!.trim() === '› Ask Codex to do anything') {
          await this.tmux(['kill-pane', '-t', paneId]);
          continue;
        }
      }
      // Keep the original terminal process and any draft without occupying the manager's layout.
      await this.tmux(['break-pane', '-d', '-s', paneId, '-n', `goal-draft-${manager}-${paneId.slice(1)}`]);
    }
    this.dismissStartupGoalMenu(id, replacement, argv, cwd);
    await this.tmux(['select-pane', '-t', replacement]);
    return true;
  }
  private async watchViewerStartup(windowId: string, argv: string[], cwd: string): Promise<void> {
    const panes = await this.paneIds(windowId);
    if (panes?.length === 1) this.dismissStartupGoalMenu(windowId, panes[0]!, argv, cwd);
  }
  private dismissStartupGoalMenu(windowId: string, paneId: string, argv: string[], cwd: string): void {
    // Limit this presentation repair to an attach/recovery event and one probe sequence per owned viewer.
    const key = JSON.stringify([windowId, paneId, argv]);
    if (this.startupMenuProbes.has(key)) return;
    this.startupMenuProbes.add(key);
    let remaining = 30;
    const probe = async () => {
      let again = false;
      try {
        const pane = await this.pane(paneId);
        if (!pane || pane.dead !== '0' || !this.sameViewer(pane, argv, cwd)) return;
        if (!(await this.paneIds(windowId))?.includes(paneId)) return;
        const capture = await this.observe(() => this.tmux(['capture-pane', '-p', '-t', paneId]));
        const selected = pausedGoalMenuSelection(capture ?? '');
        if (selected) {
          await this.tmux(['send-keys', '-t', paneId, ...(selected === 'resume' ? ['Down'] : []), 'Enter']);
          return;
        }
        // Codex can draw the composer before it obtains Goal state and opens this startup menu.
        if (--remaining) {
          again = true;
          this.deferViewerProbe(2_000, () => void probe());
        }
      } catch (error) {
        console.warn('Unable to dismiss the Codex viewer startup menu:', errorMessage(error));
      } finally {
        if (!again) this.startupMenuProbes.delete(key);
      }
    };
    this.deferViewerProbe(500, () => void probe());
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
