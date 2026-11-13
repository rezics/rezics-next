import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { processGroupRunner } from './merge.ts';
import { consumeVerifierPhaseReceipt, verifierCommandSha256 } from './dev-verifier-phase.ts';
import {
  isPlacedKernelCheckCommand,
  type VerifierPhaseChannelBinding,
} from './dev-verifier-phase-channel.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const parent = join(import.meta.dir, '../../../.temp');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'verifier-phase-channel-'));
  roots.push(root);
  return root;
}

const command = [
  'env',
  'NO_COLOR=1',
  'bun',
  'run',
  '--cwd',
  'services/kernel',
  'check',
  'test/boot/kernel-boots.test.ts',
];
const binding: VerifierPhaseChannelBinding = {
  executionId: 'boot-execution-1',
  command,
  executionBudgetMs: 500,
};

function phaseEventScript(startDelayMs: number, receiptDelayMs: number, receiptRun = 'remote-run-1'): string {
  const runner = { kind: 'check-host', id: 'remote-run-1', host: 'check-host-a' };
  const receiptRunner = { kind: 'check-host', id: receiptRun, host: 'check-host-a' };
  const start = {
    schema: 1,
    kind: 'execution-started',
    runner,
    authority: 'remote-command-started-marker',
  };
  const terminal = {
    schema: 1,
    kind: 'phase-receipt',
    receipt: {
      schema: 1,
      runner: receiptRunner,
      phases: {
        queue: { status: 'unknown', reason: 'Queue timing was unavailable.' },
        preparation: { status: 'unknown', reason: 'Preparation timing was unavailable.' },
        execution: { status: 'measured', clockId: 'check-host-a:boot-1', startedMs: 1, completedMs: 401 },
        settlement: { status: 'unknown', reason: 'Settlement timing was unavailable.' },
      },
      liveExecutionStart: {
        status: 'observed',
        authority: 'remote-command-started-marker',
      },
    },
  };
  return `
    const fs = require('node:fs');
    const nonce = process.env.REMOTE_CHECK_RECEIPT_NONCE;
    const write = (phaseEvent) => fs.writeSync(3, JSON.stringify({ nonce, phaseEvent }) + '\\n');
    setTimeout(() => write(${JSON.stringify(start)}), ${startDelayMs});
    setTimeout(() => write(${JSON.stringify(terminal)}), ${receiptDelayMs});
    setTimeout(() => process.exit(0), ${receiptDelayMs + 25});
  `;
}

async function run(script: string, timeoutMs: number) {
  const root = temporaryRoot();
  return processGroupRunner(timeoutMs, undefined, process.env, false)(
    [process.execPath, '-e', script],
    root,
    join(root, 'command.log'),
    { phaseChannel: binding },
  );
}

test('FD 3 binds a matching live Kernel phase receipt and restarts only its execution timeout', async () => {
  expect(isPlacedKernelCheckCommand(command)).toBe(true);
  expect(
    isPlacedKernelCheckCommand(['bun', 'test', 'services/kernel/test/boot/kernel-boots.test.ts']),
  ).toBe(false);

  const result = await run(phaseEventScript(300, 700), 500);
  expect(result).toMatchObject({ passed: true, timedOut: false });
  expect(result.phaseReceipt).toMatchObject({
    schema: 1,
    executionId: binding.executionId,
    commandSha256: verifierCommandSha256(binding.command),
    runner: { kind: 'check-host', id: 'remote-run-1', host: 'check-host-a' },
  });
  expect(
    consumeVerifierPhaseReceipt(result.phaseReceipt, binding).phases.execution,
  ).toMatchObject({ status: 'measured', durationMs: 400 });
  expect(
    consumeVerifierPhaseReceipt(result.phaseReceipt, {
      ...binding,
      executionId: 'another-execution',
    }).phases.execution,
  ).toMatchObject({ status: 'unknown' });
  expect(
    consumeVerifierPhaseReceipt(result.phaseReceipt, { ...binding, cwd: 'services/kernel' }).phases.execution,
  ).toMatchObject({ status: 'unknown' });
});

test('a conflicting remote host/run invalidates evidence and restores the spawn timeout', async () => {
  const result = await run(phaseEventScript(50, 450, 'different-run'), 400);
  expect(result).toMatchObject({ passed: false, timedOut: true });
  expect(result.phaseReceipt).toBeUndefined();
  expect(consumeVerifierPhaseReceipt(result.phaseReceipt, binding).phases.execution).toMatchObject({
    status: 'unknown',
  });
});

test('an absent producer keeps the existing spawn timeout and yields unknown phase evidence', async () => {
  const result = await run('setTimeout(() => process.exit(0), 800)', 300);
  expect(result).toMatchObject({ passed: false, timedOut: true });
  expect(result.phaseReceipt).toBeUndefined();
  expect(consumeVerifierPhaseReceipt(result.phaseReceipt, binding).phases.execution).toMatchObject({
    status: 'unknown',
  });
});

test('a stale per-command nonce is ignored as unknown evidence', async () => {
  const stale = `
    const fs = require('node:fs');
    const phaseEvent = {
      schema: 1,
      kind: 'execution-started',
      runner: { kind: 'check-host', id: 'old-run', host: 'check-host-a' },
      authority: 'remote-command-started-marker',
    };
    setTimeout(() => fs.writeSync(3, JSON.stringify({
      nonce: process.env.REMOTE_CHECK_RECEIPT_NONCE + '-old',
      phaseEvent,
    }) + '\\n'), 50);
    setTimeout(() => process.exit(0), 800);
  `;
  const result = await run(stale, 300);
  expect(result).toMatchObject({ passed: false, timedOut: true });
  expect(result.phaseReceipt).toBeUndefined();
  expect(consumeVerifierPhaseReceipt(result.phaseReceipt, binding).phases.execution).toMatchObject({
    status: 'unknown',
  });
});
