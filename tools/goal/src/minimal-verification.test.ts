import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { workerCheckProtocol, workerPrompt } from './launch.ts';
import { renderWorkerPrompt, selectConditions } from './prompts.ts';
import { workerCheckHostBudgetLimit } from './worker-check-budget.ts';
import type { Brief, Task } from './types.ts';
import type { ProofReservation } from './verification.ts';

const brief = {
  acceptance: { command: ['bun', 'run', '--cwd', 'services/kernel', 'check', 'test/x.test.ts'] },
  markdown: '',
} as unknown as Parameters<typeof workerCheckProtocol>[1];

test('minimal verification mode replaces acceptance checks with a local type check', () => {
  const state = mkdtempSync(join(tmpdir(), 'goal-minimal-'));
  try {
    writeFileSync(join(state, 'verification-mode'), 'minimal\n');
    const protocol = workerCheckProtocol(state, brief, state);
    expect(protocol).toContain('Verification is minimal');
    expect(protocol).toContain('typecheck');
    expect(protocol).toContain('compiler database');
    expect(protocol).toContain('env -u KERNEL_CHECK_REMOTE');
    expect(protocol).not.toContain('Run the acceptance command once');
    expect(protocol).not.toContain('--wait <id>`, poll');
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test('without the mode file the normal acceptance protocol is unchanged', () => {
  const state = mkdtempSync(join(tmpdir(), 'goal-minimal-'));
  try {
    expect(workerCheckProtocol(state, brief, state)).toContain('run your acceptance command once');
    writeFileSync(join(state, 'verification-mode'), 'full\n');
    expect(workerCheckProtocol(state, brief, state)).not.toContain('Verification is minimal');
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

function sourceWindow(run: (state: string, task: Task) => void): void {
  const state = mkdtempSync(join(tmpdir(), 'goal-source-only-'));
  try {
    writeFileSync(join(state, 'verification-mode'), 'source-only\n');
    run(state, {
      id: 'source-worker',
      currentAttempt: 1,
      worktree: '/missing-source-worktree',
      brief: {
        goal: 'web',
        manager: 'web',
        kind: 'interface',
        paths: ['apps/web/src/settings/page.tsx'],
        markdown: 'Deliver the settings source.',
        acceptance: { command: ['bun', 'test'], tests: [], failing: true, workerOwned: true },
      },
    } as unknown as Task);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}

test('source-only fresh launches override the enabled minimal budget and restore it when the window ends', () => {
  sourceWindow((state, task) => {
    expect(workerCheckHostBudgetLimit(task, 1)).not.toBe('off');
    const rendered = renderWorkerPrompt({ task, mainCheckout: '/missing-main', stateDirectory: state });
    expect(Object.keys(rendered.manifest.conditions)).toEqual(['source-only']);
    expect(rendered.deferredAcceptance).toEqual(['browser']);
    expect(rendered.prompt).toContain('do not run a new optional typecheck');
    expect(rendered.prompt).not.toContain('Typecheck each changed workspace');
    expect(rendered.prompt).not.toContain('run your acceptance command once');
    expect(rendered.prompt).not.toContain("after the wrapper's own rerun");
    writeFileSync(join(state, 'verification-mode'), 'minimal\n');
    expect(workerCheckProtocol(task.worktree, task.brief, state)).toContain('Verification is minimal');
  });
});

test('source-only retry and continuation launches retain source evidence without demanding a replay', () => {
  sourceWindow((state, task) => {
    const manifest = 'Original check 11111111-1111-4111-8111-111111111111: bun test exited 1; original.log.';
    writeFileSync(join(state, 'failure.json'), JSON.stringify({ manifest }));
    const prompt = workerPrompt(task, state, undefined, [], '/missing-main', undefined, state);
    expect(prompt).toContain(manifest);
    expect(prompt).toContain('.temp/continuation/<short-name>.md');
    expect(prompt).toContain('Do not rerun commands from a retry manifest');
    expect(prompt).not.toContain('Rerun the failing command once');
    expect(prompt).not.toContain('until it is built and its checks pass');
    expect(prompt).not.toContain('type-checking part');
    expect(prompt).not.toContain('After your last edit, run the test files');
  });
});

test('source-only wake rendering keeps the exact delivered failure and outstanding check custody', () => {
  sourceWindow((state, task) => {
    const result =
      'Check 11111111-1111-4111-8111-111111111111, physical 22222222-2222-4222-8222-222222222222: bun test exited 1. Log: /original/check.log. error: expected true.';
    const prompt = workerPrompt(task, undefined, result, [], '/missing-main', undefined, state);
    expect(prompt).toContain(result);
    expect(prompt).toContain('Missing, unknown, failed or running evidence is never a pass');
    expect(prompt).toContain('Return waiting only for a still-running check this attempt already owns');
    expect(prompt).toContain('A finished check must not be returned as waiting');
    expect(prompt).toContain('an old pass cannot prove changed source');
    expect(prompt).not.toContain('Typecheck each changed workspace');
  });
});

test('source-only money paths keep mandatory verification, including actual changes outside declared paths', () => {
  sourceWindow((state, task) => {
    for (const path of ['services/kernel/src/commerce/order.ts', 'apps/web/src/payouts/page.tsx']) {
      const money = { ...task, brief: { ...task.brief, paths: [path] } };
      expect(selectConditions({ task: money, stateDirectory: state })).toContain('minimal-verification');
      expect(workerCheckProtocol(task.worktree, money.brief, state)).toContain(
        'include payment, payout, order settlement, points or balance tests',
      );
    }
    const worktree = join(state, 'worktree');
    mkdirSync(worktree);
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: worktree, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    git('init', '-q');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'Base');
    const base = git('rev-parse', 'HEAD');
    mkdirSync(join(worktree, 'payments'));
    writeFileSync(join(worktree, 'payments', 'transfer.ts'), 'export const amount = 1;\n');
    expect(selectConditions({ task: { ...task, worktree, base }, stateDirectory: state })).toContain(
      'minimal-verification',
    );
  });
});

test('source-only keeps scoped control-plane, explicit native and original bound proof protocols', () => {
  sourceWindow((state, task) => {
    const control = { ...task.brief, goal: 'control-plane' };
    expect(workerCheckProtocol(task.worktree, control, state)).toContain('run your acceptance command once');
    const native: Brief = { ...task.brief, acceptance: { ...task.brief.acceptance, requires: ['native'] } };
    expect(workerCheckProtocol(task.worktree, native, state)).toContain('Run the chosen command once');
    const sourceCommit = 'a'.repeat(40);
    const proof = {
      ...task.brief,
      kind: 'verification' as const,
      proof: { sourceCommit, journey: 'source-only fixture', sourceTasks: [] },
    };
    const reservation = {
      status: 'bound',
      binding: {
        version: 1,
        taskId: task.id,
        attempt: 1,
        reservationToken: 'original',
        checkId: '11111111-1111-4111-8111-111111111111',
        goal: 'web',
        sourceCommit,
        sourceTree: 'b'.repeat(40),
        argv: proof.acceptance.command,
        cwd: task.worktree,
      },
    } as ProofReservation;
    const protocol = workerCheckProtocol(task.worktree, proof, state, reservation);
    expect(protocol).toContain(reservation.binding.checkId);
    expect(protocol).not.toContain('Source-only delivery');
    expect(protocol).not.toContain('Verification is minimal');
  });
});
