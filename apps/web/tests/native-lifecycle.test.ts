import { existsSync, readlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { expect } from 'bun:test';
import { resolve } from 'node:path';
import {
  currentNativeLifecycle,
  inspectNativeProcess,
  nativeProcessGroupIsGone,
  nativeProcessIsSame,
  nativeTest,
  settledWithin,
  type NativeProcessIdentity,
} from './native/lifecycle.ts';

const worktreeRoot = resolve(import.meta.dir, '../../..');
const injectionRunner = resolve(import.meta.dir, 'native/lifecycle-injection.ts');

type LifecycleReceipt = {
  listenerPort: number;
  devServerPort?: number;
  bridgeDirectory?: string;
  devServer?: NativeProcessIdentity;
  browser?: NativeProcessIdentity;
  browserNetworkNamespace?: string;
  resistantLeader?: NativeProcessIdentity;
  resistantDescendant?: NativeProcessIdentity;
  child?: NativeProcessIdentity;
  pageVisited?: boolean;
  receivedTimeout?: boolean;
  expectedFailure?: boolean;
};

async function eventuallyGone(identity: NativeProcessIdentity | undefined, timeoutMs = 3_000): Promise<boolean> {
  if (!identity) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!nativeProcessIsSame(identity)) return true;
    await Bun.sleep(25);
  }
  return !nativeProcessIsSame(identity);
}

async function eventuallyGroupGone(identity: NativeProcessIdentity | undefined, timeoutMs = 3_000): Promise<boolean> {
  if (!identity) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (nativeProcessGroupIsGone(identity)) return true;
    await Bun.sleep(25);
  }
  return nativeProcessGroupIsGone(identity);
}

function receipt(output: string, name: string): LifecycleReceipt {
  const line = output.split('\n').find((entry) => entry.startsWith(`${name} `));
  if (!line) throw new Error(`Native lifecycle injection did not report ${name}`);
  return JSON.parse(line.slice(name.length + 1)) as LifecycleReceipt;
}

async function listenerIsClosed(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
    await response.body?.cancel();
    return false;
  } catch {
    return true;
  }
}

nativeTest(
  'native lifecycle bounds a real browser timeout and partial setup failure without affecting a live sibling',
  45_000,
  async () => {
    const startedAt = performance.now();
    const lifecycle = currentNativeLifecycle();
    if (!lifecycle) throw new Error('Native lifecycle acceptance is missing its supervisor scope');
    const hostNetworkNamespace = readlinkSync('/proc/self/ns/net');
    let siblingState = 0;
    const sibling = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(`live sibling ${++siblingState}`),
    });
    lifecycle.register({
      label: 'independent live sibling listener',
      close: () => sibling.stop(true),
      force: () => sibling.stop(true),
    });
    expect(await (await fetch(sibling.url)).text()).toBe('live sibling 1');

    const runner = spawn(process.execPath, [injectionRunner], {
      cwd: worktreeRoot,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    const runnerOwner = lifecycle.ownProcessGroup('supervised native lifecycle injection command', runner);
    let output = '';
    let errorOutput = '';
    runner.stdout?.on('data', (chunk: Buffer) => (output = (output + chunk.toString()).slice(-32_000)));
    runner.stderr?.on('data', (chunk: Buffer) => (errorOutput = (errorOutput + chunk.toString()).slice(-8_000)));
    const result = await settledWithin(
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) =>
        runner.once('exit', (code, signal) => resolveExit({ code, signal })),
      ),
      28_000,
    );
    if (!result) {
      await runnerOwner.force();
      throw new Error(`Native lifecycle injection command exceeded 28000ms: ${errorOutput}`);
    }
    await runnerOwner.close();
    runnerOwner.release();

    expect(result.code).toBe(1);
    expect(result.signal).toBeNull();
    const timedOut = receipt(output, 'NATIVE_TIMEOUT_READY');
    const timedOutCleanup = receipt(output, 'NATIVE_TIMEOUT_CLEANED');
    const partial = receipt(output, 'NATIVE_PARTIAL_READY');
    const partialCleanup = receipt(output, 'NATIVE_PARTIAL_CLEANED');
    expect(timedOut.pageVisited).toBe(true);
    expect(timedOut.browserNetworkNamespace).toBeDefined();
    expect(timedOut.browserNetworkNamespace).not.toBe(hostNetworkNamespace);
    expect(timedOutCleanup.browserNetworkNamespace).toBe(timedOut.browserNetworkNamespace);
    expect(timedOutCleanup.receivedTimeout).toBe(true);
    expect(partialCleanup.expectedFailure).toBe(true);
    expect(timedOut.listenerPort).toBe(timedOutCleanup.listenerPort);
    expect(timedOut.devServerPort).toBe(timedOutCleanup.devServerPort);
    expect(timedOut.devServer).toEqual(timedOutCleanup.devServer);
    expect(timedOut.bridgeDirectory).toBe(timedOutCleanup.bridgeDirectory);
    expect(timedOut.browser).toEqual(timedOutCleanup.browser);
    expect(timedOut.resistantLeader).toEqual(timedOutCleanup.resistantLeader);
    expect(timedOut.resistantDescendant).toEqual(timedOutCleanup.resistantDescendant);
    expect(partial.listenerPort).toBe(partialCleanup.listenerPort);
    expect(partial.child).toEqual(partialCleanup.child);
    expect(existsSync(timedOut.bridgeDirectory!)).toBe(false);
    expect(await listenerIsClosed(timedOut.listenerPort)).toBe(true);
    expect(await listenerIsClosed(timedOut.devServerPort!)).toBe(true);
    expect(await listenerIsClosed(partial.listenerPort)).toBe(true);
    expect(await eventuallyGone(timedOut.browser)).toBe(true);
    expect(await eventuallyGroupGone(timedOut.browser)).toBe(true);
    expect(await eventuallyGone(timedOut.devServer)).toBe(true);
    expect(await eventuallyGroupGone(timedOut.devServer)).toBe(true);
    expect(await eventuallyGone(timedOut.resistantLeader)).toBe(true);
    expect(await eventuallyGone(timedOut.resistantDescendant)).toBe(true);
    expect(await eventuallyGone(partial.child)).toBe(true);
    expect(await (await fetch(sibling.url)).text()).toBe('live sibling 2');
    expect(await (await fetch(sibling.url)).text()).toBe('live sibling 3');
    expect(performance.now() - startedAt).toBeLessThan(28_000);
  },
  undefined,
  { cleanupGraceMs: 2_000, forceGraceMs: 3_000 },
);
