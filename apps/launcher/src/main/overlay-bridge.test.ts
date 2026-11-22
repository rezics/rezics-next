import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import {
  defaultOverlayShortcut,
  overlayPanelLimit,
  overlaySessionFrameLimit,
  type OverlayPreferences,
  type Session,
} from '@rezics/launcher-contract';
import type { OverlayFailure, OverlayStatus } from '../shared/desktop';
import { OverlayBridge } from './overlay-bridge';

test.skipIf(process.platform === 'win32')('restarts and stops an exited overlay despite inherited pipes', async () => {
  const scratch = resolve('.temp');
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'overlay-retained-pipe-'));
  const executable = join(directory, 'overlay.mjs');
  const release = join(directory, 'exit');
  const log = join(directory, 'descendants');
  const statuses: OverlayStatus[] = [];
  const bridge = new OverlayBridge(
    executable,
    async () => {},
    (status) => statuses.push(status),
  );
  try {
    await writeFile(
      executable,
      `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout } from 'node:timers/promises';
const log = ${JSON.stringify(log)};
const first = !existsSync(log);
const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 12000)'], {
  stdio: ['ignore', 'inherit', 'inherit'],
});
descendant.unref();
appendFileSync(log, descendant.pid + '\\n');
const send = (frame) => console.log(JSON.stringify({v:1, ...frame}));
send({type:'ready'});
createInterface({input:process.stdin}).once('line', async (line) => {
  const {sessionId} = JSON.parse(line).session;
  send({type:'session-status', sessionId, attached:true});
  if (first) {
    while (!existsSync(${JSON.stringify(release)})) await setTimeout(10);
    process.exit(1);
  }
});`,
      { mode: 0o700 },
    );
    bridge.setSession({
      sessionId: 'retained-pipe',
      instanceId: 'fixture',
      pid: process.pid,
      title: 'Fixture',
      startedAt: Date.now(),
      destinations: [],
    });
    expect(await waitForAttachments(1)).toBe(true);
    await writeFile(release, '');
    expect(await waitForAttachments(2)).toBe(true);
    expect(await Promise.race([bridge.stop().then(() => true), setTimeout(2000, false, { ref: false })])).toBe(true);
    expect(bridge.status()).toEqual({ state: 'inactive' });
  } finally {
    const descendants = (await readFile(log, 'utf8').catch(() => '')).trim().split('\n');
    for (const pid of descendants.map(Number)) {
      if (pid > 0) {
        try {
          process.kill(pid);
        } catch {
          // An already exited fixture needs no cleanup.
        }
      }
    }
    await bridge.stop();
    await rm(directory, { recursive: true, force: true });
  }

  async function waitForAttachments(count: number) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (statuses.filter(({ state }) => state === 'ready').length === count) return true;
      await setTimeout(20);
    }
    return false;
  }
});

test.skipIf(process.platform === 'win32')(
  'updates a slow overlay with the latest snapshot without queuing every superseded panel change',
  async () => {
    const scratch = resolve('.temp');
    await mkdir(scratch, { recursive: true });
    const directory = await mkdtemp(join(scratch, 'overlay-bridge-'));
    const executable = join(directory, 'overlay.mjs');
    const release = join(directory, 'release');
    const observed = join(directory, 'observed.json');
    const primary = { id: 'primary', title: 'Primary panel', text: '界'.repeat(400) };
    const others = Array.from({ length: overlayPanelLimit - 1 }, (_, index) => ({
      id: String(index),
      title: `Panel ${index}`,
      text: primary.text,
    }));
    const session: Session = {
      sessionId: 'current',
      instanceId: 'game-fixture',
      startedAt: Date.now(),
      pid: process.pid,
      title: 'Fixture',
      destinations: [],
      panels: [primary, ...others],
    };
    const bridge = new OverlayBridge(executable, async () => {});
    try {
      await writeFile(
        executable,
        `#!/usr/bin/env node
import { once } from 'node:events';
import { existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout } from 'node:timers/promises';
const send = (message) => console.log(JSON.stringify({v: 1, ...message}));
const input = createInterface({input: process.stdin});
const attached = once(input, 'line');
send({type: 'ready', sessionFrameLimit: ${overlaySessionFrameLimit}});
const [initial] = await attached;
input.pause();
const {sessionId} = JSON.parse(initial).session;
send({type: 'session-status', sessionId, attached: true});
let updates = 0;
input.on('line', (line) => {
  const {session} = JSON.parse(line);
  updates++;
  if (session.panels[0].title === 'Latest panel') {
    writeFileSync(${JSON.stringify(observed)}, JSON.stringify({updates, session}));
  }
});
while (!existsSync(${JSON.stringify(release)})) await setTimeout(10);
input.resume();`,
        { mode: 0o700 },
      );
      bridge.setSession(session);
      const attached = await until(() => bridge.status().state === 'ready');
      expect(attached).toBe(true);

      for (let index = 0; index < 512; index++) {
        bridge.setSession({ ...session, panels: [{ ...primary, title: `Revision ${index}` }, ...others] });
      }
      const latest: Session = {
        ...session,
        panels: [{ ...primary, title: 'Latest panel' }, ...others],
      };
      bridge.setSession(latest);
      await writeFile(release, '');
      const result = await until(async () => {
        const contents = await readFile(observed, 'utf8').catch(() => '');
        if (contents) return JSON.parse(contents) as { updates: number; session: Session };
      });
      expect(result?.session).toEqual(latest);
      expect(result?.updates).toBeLessThan(32);
      expect(bridge.status()).toMatchObject({ state: 'ready', sessionId: session.sessionId });
    } finally {
      await bridge.stop();
      await rm(directory, { recursive: true, force: true });
    }

    async function until<T>(read: () => T | Promise<T>): Promise<T | undefined> {
      for (let attempt = 0; attempt < 150; attempt++) {
        const result = await read();
        if (result) return result;
        await setTimeout(20);
      }
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'waits for the retiring overlay before binding the newest session',
  async () => {
    const scratch = resolve('.temp');
    await mkdir(scratch, { recursive: true });
    const directory = await mkdtemp(join(scratch, 'overlay-bridge-'));
    const executable = join(directory, 'overlay.mjs');
    const log = join(directory, 'activity.log');
    const bridge = new OverlayBridge(executable, async () => {});
    const session: Session = {
      sessionId: 'first',
      instanceId: 'game-fixture',
      startedAt: Date.now(),
      pid: process.pid,
      title: 'Fixture',
      destinations: [],
    };
    try {
      await writeFile(
        executable,
        `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = (message) => appendFileSync(${JSON.stringify(log)}, message + '\\n');
log('start');
console.log('{"v":1,"type":"ready"}');
createInterface({ input: process.stdin }).on('line', (line) => {
  const {sessionId} = JSON.parse(line).session;
  log(sessionId);
  console.log(JSON.stringify({v: 1, type: 'session-status', sessionId, attached: true}));
});
process.stdin.on('end', () => setTimeout(() => log('retire'), 200));`,
        { mode: 0o700 },
      );

      bridge.setSession(session);
      await contains('first');
      bridge.setSession(null);
      bridge.setSession({ ...session, sessionId: 'skipped' });
      bridge.setSession({ ...session, sessionId: 'latest' });
      expect((await contains('latest')).trim().split('\n')).toEqual(['start', 'first', 'retire', 'start', 'latest']);
      bridge.stop();
      await contains('latest\nretire');
    } finally {
      bridge.stop();
      await rm(directory, { recursive: true, force: true });
    }

    async function contains(value: string): Promise<string> {
      for (let attempt = 0; attempt < 150; attempt++) {
        const activity = await readFile(log, 'utf8').catch(() => '');
        if (activity.includes(value)) return activity;
        await setTimeout(20);
      }
      throw new Error(`Overlay did not record ${value}.`);
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'requires the current attachment, bounds crash retries, and restarts only the current session',
  async () => {
    const scratch = resolve('.temp');
    await mkdir(scratch, { recursive: true });
    const directory = await mkdtemp(join(scratch, 'overlay-failure-'));
    const executable = join(directory, 'overlay.mjs');
    const mode = join(directory, 'mode');
    const log = join(directory, 'activity.log');
    const reports: OverlayStatus[] = [];
    const destinations: string[] = [];
    const persisted: OverlayPreferences[] = [];
    let blockWrite = false;
    const bridge = new OverlayBridge(
      executable,
      async (_, destination) => {
        destinations.push(destination);
      },
      (status) => reports.push(status),
      {
        value: { enabled: true, shortcut: defaultOverlayShortcut },
        save: async (preferences) => {
          if (blockWrite) throw new Error('Preference storage unavailable.');
          persisted.push(preferences);
        },
      },
    );
    const session = {
      sessionId: 'current',
      instanceId: 'fixture',
      pid: process.pid,
      startedAt: Date.now(),
      title: 'Fixture',
      destinations: [{ id: 'guide', label: 'Guide' }],
    } satisfies Session;
    try {
      await writeFile(mode, 'hotkey');
      await writeFile(
        executable,
        `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const mode = readFileSync(${JSON.stringify(mode)}, 'utf8');
appendFileSync(${JSON.stringify(log)}, mode + '\\n');
const send = (message) => process.stdout.write(JSON.stringify({v: 1, ...message}) + '\\n');
const startupFailures = {
  hotkey: 'hotkey-unavailable',
  webview2: 'webview2-unavailable',
  'webview2-startup': 'webview2-unavailable',
};
const shortcut = mode === 'healthy' && process.argv[2] === '--shortcut' ? process.argv[3] : undefined;
send({type: startupFailures[mode] ?? 'ready', shortcut, ...(mode === 'webview2-startup' && {runtimeDetected: true})});
createInterface({ input: process.stdin }).on('line', (line) => {
  const {sessionId} = JSON.parse(line).session;
  if (mode === 'session') {
    send({type: 'session-status', sessionId: 'stale', attached: true});
    send({type: 'open-destination', sessionId, destination: 'guide'});
  }
  const sent = JSON.stringify({v: 1, type: 'session-status', sessionId, attached: mode !== 'session'});
  process.stdout.write(sent + '\\n', () => {
    if (mode === 'crash') process.exit(1);
  });
});
process.stdin.on('end', () => {
  if (mode === 'healthy') appendFileSync(${JSON.stringify(log)}, 'retired\\n');
});`,
        { mode: 0o700 },
      );

      bridge.setSession(session);
      await waitFor({ state: 'failed', sessionId: 'current', reason: 'hotkey' });
      bridge.setSession({ ...session, title: 'Updated' });
      expect(await readFile(log, 'utf8')).toBe('hotkey\n');
      expect(() => bridge.restart('stale')).toThrow('session has ended');

      await writeFile(mode, 'webview2');
      bridge.restart(session.sessionId);
      await waitFor({ state: 'failed', sessionId: 'current', reason: 'webview2' });
      bridge.setSession({ ...session, title: 'Updated again' });
      expect(await readFile(log, 'utf8')).toBe('hotkey\nwebview2\n');

      await writeFile(mode, 'webview2-startup');
      bridge.restart(session.sessionId);
      await waitFor({ state: 'failed', sessionId: 'current', reason: 'webview2-startup' });
      expect(await readFile(log, 'utf8')).toBe('hotkey\nwebview2\nwebview2-startup\n');

      await writeFile(mode, 'session');
      bridge.restart(session.sessionId);
      await waitFor({ state: 'failed', sessionId: 'current', reason: 'session' });
      expect(await readFile(log, 'utf8')).toBe('hotkey\nwebview2\nwebview2-startup\nsession\n');
      expect(reports.some(({ state }) => state === 'ready')).toBe(false);
      expect(destinations).toEqual([]);

      await writeFile(mode, 'crash');
      bridge.restart(session.sessionId);
      await waitFor({ state: 'failed', sessionId: 'current', reason: 'exited' });
      expect(await readFile(log, 'utf8')).toBe('hotkey\nwebview2\nwebview2-startup\nsession\ncrash\ncrash\n');
      expect(reports.filter(({ state }) => state === 'ready')).toHaveLength(2);

      await writeFile(mode, 'healthy');
      bridge.restart(session.sessionId);
      await waitFor({ state: 'ready', sessionId: 'current' });
      bridge.restart(session.sessionId);
      await waitFor({ state: 'ready', sessionId: 'current' });
      expect(await readFile(log, 'utf8')).toBe(
        'hotkey\nwebview2\nwebview2-startup\nsession\ncrash\ncrash\nhealthy\nretired\nhealthy\n',
      );
      await expect(bridge.setShortcut('stale', 'ctrl-shift-f9')).rejects.toThrow('session has ended');
      await writeFile(mode, 'legacy');
      await bridge.setShortcut(session.sessionId, 'ctrl-shift-f9');
      await waitFor({ state: 'failed', sessionId: 'current', reason: 'shortcut-mismatch' });
      expect(bridge.status()).toMatchObject({ shortcut: 'ctrl-shift-f9' });

      await writeFile(mode, 'healthy');
      await bridge.setShortcut(session.sessionId, 'ctrl-shift-f10');
      await waitFor({ state: 'ready', sessionId: 'current' });
      expect(bridge.status()).toMatchObject({ shortcut: 'ctrl-shift-f10' });
      expect(persisted).toEqual([
        { enabled: true, shortcut: 'ctrl-shift-f9' },
        { enabled: true, shortcut: 'ctrl-shift-f10' },
      ]);
      blockWrite = true;
      await expect(bridge.updatePreferences({ enabled: false })).rejects.toThrow('Preference storage unavailable.');
      expect(bridge.status()).toMatchObject({ state: 'ready', sessionId: 'current' });
      blockWrite = false;
      await bridge.updatePreferences({ enabled: false });
      expect(bridge.status()).toMatchObject({ state: 'disabled', sessionId: 'current' });
      expect(() => bridge.restart(session.sessionId)).toThrow('Enable Overlay');
      bridge.setSession({ ...session, title: 'Updated while disabled' });
      await bridge.updatePreferences({ shortcut: 'ctrl-shift-space' });
      expect(bridge.status()).toMatchObject({ state: 'disabled', shortcut: 'ctrl-shift-space' });
      await bridge.updatePreferences({ enabled: true });
      await waitFor({ state: 'ready', sessionId: 'current' });
      expect(bridge.status()).toMatchObject({ shortcut: 'ctrl-shift-space' });
      bridge.stop();
      await waitFor({ state: 'inactive' });
      for (let attempt = 0; attempt < 80; attempt++) {
        if ((await readFile(log, 'utf8')).endsWith('healthy\nretired\n')) return;
        await setTimeout(20);
      }
      throw new Error('The sidecar did not retire.');
    } finally {
      bridge.stop();
      await rm(directory, { recursive: true, force: true });
    }

    async function waitFor(status: { state: OverlayStatus['state']; sessionId?: string; reason?: OverlayFailure }) {
      for (let attempt = 0; attempt < 80; attempt++) {
        const current = bridge.status();
        if (
          current.state === status.state &&
          (!('sessionId' in status) || ('sessionId' in current && current.sessionId === status.sessionId)) &&
          (!('reason' in status) || ('reason' in current && current.reason === status.reason))
        )
          return;
        await setTimeout(20);
      }
      expect(bridge.status()).toMatchObject(status);
    }
  },
);
