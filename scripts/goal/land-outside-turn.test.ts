import { afterAll, expect, test } from 'bun:test';
import type { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { landingEnv, landsOutsideTurn, reportLanding, startLandingOutsideTurn } from './land-outside-turn.ts';
import { spawnSettlement } from './settle.ts';
import type { Task } from './types.ts';

const scratch = mkdtempSync(join(tmpdir(), 'land-outside-turn-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test('the detached settlement child carries the landing environment without the manager turn', () => {
  const calls: Record<string, unknown>[] = [];
  let unreferenced = false;
  const start = ((_program: string, _args: readonly string[], options: Record<string, unknown>) => {
    calls.push(options);
    return { pid: 42424242, on: () => {}, unref: () => { unreferenced = true; } };
  }) as unknown as typeof spawn;
  const token = process.env.GOAL_TURN_TOKEN;
  const state = process.env.GOAL_TURN_STATE_DIR;
  process.env.GOAL_TURN_TOKEN = 'manager-turn';
  process.env.GOAL_TURN_STATE_DIR = '/manager-turn';
  try {
    spawnSettlement({ id: 'task', goal: 'alpha', attempts: [{ n: 1 }] } as Task, 'claim',
      { start, directory: join(scratch, 'settlement') });
    expect(calls[0]).toMatchObject({ detached: true, env: { GOAL_ID: 'alpha' } });
    const env = calls[0]!.env as NodeJS.ProcessEnv;
    expect(env.GOAL_TURN_TOKEN).toBeUndefined();
    expect(env.GOAL_TURN_STATE_DIR).toBeUndefined();
    expect(unreferenced).toBe(true);
  } finally {
    if (token === undefined) delete process.env.GOAL_TURN_TOKEN; else process.env.GOAL_TURN_TOKEN = token;
    if (state === undefined) delete process.env.GOAL_TURN_STATE_DIR; else process.env.GOAL_TURN_STATE_DIR = state;
  }
});

test('only a manager turn lands outside itself; a worker and a terminal land in place', () => {
  expect(landsOutsideTurn({ GOAL_TURN_TOKEN: 'turn' })).toBe(true);
  expect(landsOutsideTurn({ GOAL_TURN_TOKEN: 'turn', GOAL_TASK_ID: 'G-1' })).toBe(false);
  expect(landsOutsideTurn({ GOAL_ID: 'api' })).toBe(false);
});

test('the landing starts in its own session without the token a cut turn kills by', () => {
  const calls: { program: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
  let unreferenced = false;
  const start = ((program: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ program, args, options });
    return { pid: 4242, unref: () => { unreferenced = true; } };
  }) as unknown as typeof spawn;
  const env = { GOAL_ID: 'api', GOAL_TURN_TOKEN: 'turn', GOAL_TURN_STATE_DIR: '/state', PATH: '/bin' };
  const message = startLandingOutsideTurn({ id: 'G-7', step: true, runDir: join(scratch, 'runs', 'G-7'), root: scratch,
    script: '/repo/scripts/goal/goalctl.ts', env, start });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.program).toBe(process.execPath);
  expect(calls[0]!.args).toEqual(['/repo/scripts/goal/goalctl.ts', 'land', 'G-7', '--step', '--report']);
  expect(calls[0]!.options).toMatchObject({ cwd: scratch, detached: true, env: { GOAL_ID: 'api', PATH: '/bin' } });
  expect(calls[0]!.options.env).toEqual(landingEnv(env));
  expect(Object.keys(calls[0]!.options.env as object)).not.toContain('GOAL_TURN_TOKEN');
  expect(Object.keys(calls[0]!.options.env as object)).not.toContain('GOAL_TURN_STATE_DIR');
  expect(unreferenced).toBe(true);
  expect(message).toContain('G-7: landing started outside this turn (pid 4242)');
  expect(message).toContain('do not wait for it and do not start it again');
  expect(message).toContain(join(scratch, 'runs', 'G-7', 'land.log'));

  const whole = startLandingOutsideTurn({ id: 'G-8', step: false, runDir: join(scratch, 'runs', 'G-8'), root: scratch,
    script: '/repo/scripts/goal/goalctl.ts', env, start });
  expect(calls[1]!.args).toEqual(['/repo/scripts/goal/goalctl.ts', 'land', 'G-8', '--report']);
  expect(whole).toContain('G-8');
});

test('a landing that did not start is an error of the turn, not a silent promise of mail', () => {
  const start = (() => ({ pid: undefined, unref: () => {} })) as unknown as typeof spawn;
  expect(() => startLandingOutsideTurn({ id: 'G-9', step: false, runDir: join(scratch, 'runs', 'G-9'), root: scratch,
    script: '/repo/scripts/goal/goalctl.ts', env: {}, start })).toThrow('G-9: landing did not start');
});

test('the landing mails its Goal the result once, whether it landed or was refused', async () => {
  const sent: [string, string][] = [];
  const send = (body: string, key: string) => { sent.push([body, key]); };
  expect(await reportLanding('G-7', true, async () => {}, send, () => 11)).toBe(0);
  expect(sent[0]).toEqual([
    '`land G-7 --step` succeeded. If G-7 is still open, close it (`close G-7 verified`) when nothing is left of its brief, or resume its worker.',
    'land-G-7-11',
  ]);
  const error = console.error;
  console.error = () => {};
  try {
    expect(await reportLanding('G-8', false, async () => { throw new Error('G-8: land requires a clean worktree'); }, send, () => 12)).toBe(1);
    expect(sent[1]).toEqual(['`land G-8` did not land: G-8: land requires a clean worktree', 'land-G-8-12']);
    expect(await reportLanding('G-9', false, async () => { throw new Error('x'.repeat(4000)); }, send, () => 13)).toBe(1);
  } finally { console.error = error; }
  expect(sent[2]![0].length).toBeLessThan(1600);
  expect(sent[2]![0].endsWith(' …')).toBe(true);
  expect(sent).toHaveLength(3);
});
