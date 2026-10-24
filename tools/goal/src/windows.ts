import { spawnSync } from 'node:child_process';

export type WindowSettings = { socket: string; session: string };
export type WindowRunner = (executable: string, argv: string[]) => string;
const run: WindowRunner = (executable, argv) => {
  const result = spawnSync(executable, argv, { encoding: 'utf8', timeout: 15_000 });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || `${executable} failed`);
  return result.stdout.trim();
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export interface ManagerWindows {
  register(manager: string, argv: string[], cwd: string): string;
  unregister(manager: string): void;
}

/** Resolve termspaces' stable session option; do not inspect or kill unrelated windows. */
export class TermspacesWindows implements ManagerWindows {
  constructor(private readonly settings: WindowSettings, private readonly execute: WindowRunner = run) {}
  private tmux(argv: string[]): string { return this.execute('tmux', ['-S', this.settings.socket, ...argv]); }
  private lookupSession(): string | undefined {
    try {
      return this.tmux(['list-sessions', '-F', '#{session_id}\t#{session_name}\t#{@ts-session-id}'])
        .split('\n').map(line => line.split('\t')).find(([, name, id]) => name === this.settings.session || id === this.settings.session)?.[0];
    } catch { return undefined; }
  }
  private session(): string {
    let session = this.lookupSession();
    if (!session) { this.execute('termspaces', ['--socket-path', this.settings.socket, 'apply']); session = this.lookupSession(); }
    if (!session) throw new Error(`Missing termspaces session: ${this.settings.session}`);
    return session;
  }
  register(manager: string, argv: string[], cwd: string): string {
    const session = this.session();
    const existing = this.find(session, manager);
    if (existing) return existing;
    const id = this.tmux(['new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${session}:`,
      '-n', `goal-${manager}`, '-c', cwd, argv.map(quote).join(' ')]);
    try { this.tmux(['set-option', '-w', '-t', id, '@goal-manager', manager]); }
    catch (error) { this.tmux(['kill-window', '-t', id]); throw error; }
    return id;
  }
  private find(session: string, manager: string): string | undefined {
    return this.tmux(['list-windows', '-t', session, '-F', '#{window_id}\t#{@goal-manager}'])
      .split('\n').map(line => line.split('\t')).find(([, owner]) => owner === manager)?.[0];
  }
  unregister(manager: string): void {
    const session = this.lookupSession();
    if (!session) return;
    const id = this.find(session, manager);
    if (id) this.tmux(['kill-window', '-t', id]);
  }
}
