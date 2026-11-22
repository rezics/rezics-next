import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { defaultOverlayShortcut, overlayFrameLimit } from '@rezics/launcher-contract';
import type { DestinationId, OverlayPreferences, OverlayShortcut, Session } from '@rezics/launcher-contract';
import type { OverlayFailure, OverlayStatus } from '../shared/desktop';
import { encodeOverlaySession, readOverlayFrames } from './overlay-frames';

type Sidecar = {
  child: ChildProcessWithoutNullStreams;
  sessionId: string;
  shortcut: OverlayShortcut;
  phase: 'starting' | 'attaching' | 'ready' | 'retiring';
  sessionFrameLimit: number;
  writingSnapshot?: boolean;
  refreshPending?: boolean;
  exited?: true;
  failure?: OverlayFailure;
  timer?: NodeJS.Timeout;
};
type PreferenceStore = { value: OverlayPreferences; save(value: OverlayPreferences): Promise<void> };
const pipeDrainTimeMs = 250;

export class OverlayBridge {
  #sidecar: Sidecar | undefined;
  #status: OverlayStatus = { state: 'inactive' };
  #session: Session | null = null;
  #automaticRetry = true;
  #preferences: OverlayPreferences;
  #savingPreferences: Promise<OverlayPreferences> | undefined;

  constructor(
    readonly executable: string | undefined,
    readonly open: (sessionId: string, destination: DestinationId) => Promise<void>,
    readonly notify: (status: OverlayStatus) => void = () => {},
    readonly settings: PreferenceStore = {
      value: { enabled: true, shortcut: defaultOverlayShortcut },
      save: async () => {},
    },
    readonly notifyPreferences: (value: OverlayPreferences) => void = () => {},
  ) {
    this.#preferences = { ...settings.value };
  }

  status(): OverlayStatus {
    return this.#status;
  }

  preferences(): OverlayPreferences {
    return { ...this.#preferences };
  }

  setSession(session: Session | null): void {
    if (!session) {
      void this.stop();
      return;
    }
    const changed = this.#session?.sessionId !== session.sessionId;
    this.#session = session;
    if (!changed) {
      if (this.#sidecar) this.#send(this.#sidecar);
      return;
    }

    this.#applyPreferences(session.sessionId);
  }

  restart(sessionId: string): void {
    if (this.#session?.sessionId !== sessionId) throw new Error('The game session has ended.');
    if (!this.#preferences.enabled) throw new Error('Enable Overlay before restarting it.');
    if (this.#status.state !== 'ready' && this.#status.state !== 'failed') return;
    this.#automaticRetry = true;
    this.#launchForSession(sessionId);
  }

  async setShortcut(sessionId: string, shortcut: OverlayShortcut): Promise<void> {
    if (this.#session?.sessionId !== sessionId || !this.executable) throw new Error('The game session has ended.');
    await this.updatePreferences({ shortcut });
  }

  async updatePreferences(patch: Partial<OverlayPreferences>): Promise<OverlayPreferences> {
    if (this.#savingPreferences) throw new Error('Wait for the current Overlay settings to save.');
    const next = { ...this.#preferences, ...patch };
    if (next.enabled === this.#preferences.enabled && next.shortcut === this.#preferences.shortcut)
      return this.preferences();
    const work = this.#savePreferences(next);
    this.#savingPreferences = work;
    try {
      return await work;
    } finally {
      this.#savingPreferences = undefined;
    }
  }

  async waitForPreferences(): Promise<void> {
    await this.#savingPreferences?.catch(() => {});
  }

  async #savePreferences(next: OverlayPreferences): Promise<OverlayPreferences> {
    await this.settings.save(next);
    this.#preferences = next;
    if (this.#session) this.#applyPreferences(this.#session.sessionId);
    const value = this.preferences();
    this.notifyPreferences(value);
    return value;
  }

  #applyPreferences(sessionId: string): void {
    if (!this.#preferences.enabled) {
      if (this.#sidecar) this.#retire(this.#sidecar);
      this.#publish({ state: 'disabled', sessionId, shortcut: this.#preferences.shortcut });
    } else if (this.executable) {
      this.#automaticRetry = true;
      this.#launchForSession(sessionId);
    } else if (this.#status.state !== 'inactive') {
      this.#publish({ state: 'inactive' });
    }
  }

  stop(): Promise<void> {
    this.#session = null;
    const sidecar = this.#sidecar;
    if (sidecar) this.#retire(sidecar);
    if (this.#status.state !== 'inactive') this.#publish({ state: 'inactive' });
    return sidecar ? new Promise<void>((resolve) => sidecar.child.once('close', () => resolve())) : Promise.resolve();
  }

  #launchForSession(sessionId: string): void {
    this.#publish({ state: 'starting', sessionId, shortcut: this.#preferences.shortcut });
    if (this.#sidecar) this.#retire(this.#sidecar);
    else this.#start(sessionId);
  }

  #publish(status: OverlayStatus): void {
    this.#status = status;
    this.notify(status);
  }

  #retire(sidecar: Sidecar): void {
    if (sidecar.phase === 'retiring') return;
    sidecar.phase = 'retiring';
    if (sidecar.exited) return;
    clearTimeout(sidecar.timer);
    sidecar.child.stdin.end();
    sidecar.timer = setTimeout(() => sidecar.child.kill('SIGKILL'), 2000).unref();
  }

  #start(sessionId: string): void {
    const shortcut = this.#preferences.shortcut;
    if (!this.executable || !existsSync(this.executable)) {
      this.#publish({ state: 'failed', reason: 'missing', sessionId, shortcut });
      return;
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      const args = shortcut === defaultOverlayShortcut ? [] : ['--shortcut', shortcut];
      child = spawn(this.executable, args, { windowsHide: true, stdio: 'pipe' });
    } catch {
      this.#publish({ state: 'failed', reason: 'startup', sessionId, shortcut });
      return;
    }
    const sidecar: Sidecar = { child, sessionId, shortcut, phase: 'starting', sessionFrameLimit: overlayFrameLimit };
    this.#sidecar = sidecar;
    sidecar.timer = setTimeout(() => this.#fail(sidecar, 'timeout'), 12_000).unref();
    child.stdout.on(
      'data',
      readOverlayFrames((frame) => {
        if (this.#sidecar !== sidecar || sidecar.phase === 'retiring' || sidecar.failure) return;
        if (frame.type === 'hotkey-unavailable') {
          if (sidecar.phase === 'starting') this.#fail(sidecar, 'hotkey');
        } else if (frame.type === 'webview2-unavailable') {
          if (sidecar.phase === 'starting')
            this.#fail(sidecar, frame.runtimeDetected ? 'webview2-startup' : 'webview2');
        } else if (frame.type === 'ready') {
          if (sidecar.phase !== 'starting' || sidecar.exited) return;
          if ((frame.shortcut ?? defaultOverlayShortcut) !== shortcut) {
            this.#fail(sidecar, 'shortcut-mismatch');
            return;
          }
          sidecar.sessionFrameLimit = frame.sessionFrameLimit ?? overlayFrameLimit;
          sidecar.phase = 'attaching';
          this.#send(sidecar);
        } else if (frame.type === 'session-status') {
          if (
            frame.sessionId !== sessionId ||
            frame.sessionId !== this.#session?.sessionId ||
            sidecar.phase === 'starting'
          )
            return;
          if (!frame.attached) {
            this.#fail(sidecar, 'session');
          } else if (sidecar.phase === 'attaching' && !sidecar.exited) {
            clearTimeout(sidecar.timer);
            sidecar.phase = 'ready';
            this.#publish({ state: 'ready', sessionId, shortcut });
          }
        } else if (
          sidecar.phase === 'ready' &&
          !sidecar.exited &&
          frame.sessionId === this.#session?.sessionId &&
          this.#session.destinations.some((target) => target.id === frame.destination)
        ) {
          void this.open(frame.sessionId, frame.destination).catch(() => {
            console.error('Could not open the destination requested by Overlay.');
          });
        }
      }),
    );
    child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    child.once('error', () => this.#fail(sidecar, 'startup'));
    child.stdin.on('error', () => this.#fail(sidecar, sidecar.phase === 'ready' ? 'exited' : 'startup'));
    child.once('exit', () => {
      sidecar.exited = true;
      clearTimeout(sidecar.timer);
      // Allow final diagnostics to arrive without waiting on inherited handles.
      sidecar.timer = setTimeout(() => {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }, pipeDrainTimeMs).unref();
    });
    child.once('close', () => this.#closed(sidecar));
  }

  #fail(sidecar: Sidecar, reason: OverlayFailure): void {
    if (this.#sidecar !== sidecar || sidecar.phase === 'retiring' || sidecar.failure) return;
    sidecar.failure = reason;
    if (sidecar.exited) return;
    clearTimeout(sidecar.timer);
    sidecar.child.kill('SIGKILL');
  }

  #closed(sidecar: Sidecar): void {
    if (this.#sidecar !== sidecar) return;
    clearTimeout(sidecar.timer);
    this.#sidecar = undefined;
    const sessionId = this.#session?.sessionId;
    if (!sessionId || !this.#preferences.enabled) return;
    if (sidecar.phase === 'retiring') {
      this.#start(sessionId);
      return;
    }
    const reason = sidecar.failure ?? (sidecar.phase === 'ready' ? 'exited' : 'startup');
    if (
      this.#automaticRetry &&
      !['hotkey', 'shortcut-mismatch', 'session', 'webview2', 'webview2-startup'].includes(reason)
    ) {
      this.#automaticRetry = false;
      this.#launchForSession(sessionId);
    } else {
      this.#publish({ state: 'failed', reason, sessionId, shortcut: sidecar.shortcut });
    }
  }

  #send(sidecar: Sidecar): void {
    if (
      this.#sidecar !== sidecar ||
      (sidecar.phase !== 'attaching' && sidecar.phase !== 'ready') ||
      sidecar.exited ||
      sidecar.failure ||
      sidecar.sessionId !== this.#session?.sessionId
    )
      return;
    if (sidecar.writingSnapshot) {
      sidecar.refreshPending = true;
      return;
    }
    const frame = encodeOverlaySession(this.#session, sidecar.sessionFrameLimit);
    if (frame === undefined) {
      this.#fail(sidecar, 'session');
      return;
    }

    // A snapshot replaces earlier pending state for this session.
    sidecar.writingSnapshot = true;
    sidecar.refreshPending = false;
    sidecar.child.stdin.write(`${frame}\n`, (error) => {
      sidecar.writingSnapshot = false;
      if (!error && sidecar.refreshPending) this.#send(sidecar);
    });
  }
}
