import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openDb } from '../tools/goal/src/db.ts';
import { readFlow } from '../tools/goal/src/flow.ts';
import { recordRemoteCheckFlow } from './remote-check.ts';

test('remote check slot requests, acquisitions and releases persist task timestamps', () => {
  const root = mkdtempSync(join(tmpdir(), 'remote-check-flow-'));
  const state = join(root, 'state');
  const waitFile = join(state, 'runs', 'task', '0.check-wait');
  mkdirSync(dirname(waitFile), { recursive: true });
  const env = { GOAL_TASK_ID: 'task', GOAL_ATTEMPT: '0', GOAL_CHECK_WAIT_FILE: waitFile };
  recordRemoteCheckFlow('requested', env, new Date('2026-10-29T00:00:00.000Z'));
  recordRemoteCheckFlow('acquired', env, new Date('2026-10-29T00:00:02.000Z'));
  recordRemoteCheckFlow('released', env, new Date('2026-10-29T00:00:03.000Z'));
  const db = openDb(join(state, 'goal.sqlite'));
  expect(readFlow(db).map(event => [event.stage, event.action])).toEqual([
    ['check', 'requested'], ['check', 'acquired'], ['check', 'released'],
  ]);
  db.close();
  rmSync(root, { recursive: true, force: true });
});
