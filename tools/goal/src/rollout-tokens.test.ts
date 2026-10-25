import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMeasurement } from './records.ts';
import type { Attempt } from './types.ts';

const session = '01a17045-0000-7000-8000-000000000001';
const usage = (input: number, cached: number, output: number) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output });
const lines = (events: object[]) => events.map(event => JSON.stringify(event)).join('\n') + '\n';

function fixture(stream: object[]) {
  const root = mkdtempSync(join(tmpdir(), 'goal-rollout-'));
  const configDirectory = join(root, 'codex-home'), day = join(configDirectory, 'sessions', '2026', '10', '25');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, `rollout-2026-10-25T00-23-12-${session}.jsonl`), lines([
    { timestamp: '2026-10-25T00:23:20.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(1000, 800, 50) } } },
    { timestamp: '2026-10-25T00:24:40.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(4000, 3500, 200) } } },
  ]));
  const logPath = join(root, '1.jsonl');
  writeFileSync(logPath, lines(stream));
  // The session is not on the attempt: a stopped attempt only has it in its event stream.
  const attempt = { taskId: 't', attempt: 1, logPath, session: null, startedAt: '2026-10-25T00:23:12.000Z', endedAt: '2026-10-25T00:24:53.000Z' } as unknown as Attempt;
  return { attempt, configDirectory };
}

const started = [{ type: 'thread.started', thread_id: session }, { type: 'turn.started' }];

test('an attempt stopped before turn.completed is measured from its Codex session rollout', () => {
  const { attempt, configDirectory } = fixture([...started, { type: 'item.started', item: { type: 'command_execution', command: 'bun test' } }]);
  const measured = readMeasurement(attempt, { configDirectory });
  expect(measured.tokens).toEqual({ input: 4000, cached: 3500, output: 200 });
  expect(measured.session).toBe(session);
});

test('a completed turn is counted once even when a rollout exists', () => {
  const { attempt, configDirectory } = fixture([...started, { type: 'turn.completed', usage: usage(4000, 3500, 200) }]);
  expect(readMeasurement(attempt, { configDirectory }).tokens).toEqual({ input: 4000, cached: 3500, output: 200 });
});

test('a baseline still yields the increment of a resumed session', () => {
  const { attempt, configDirectory } = fixture([...started]);
  expect(readMeasurement(attempt, { configDirectory, baseline: { input: 1000, cached: 800, output: 50 } }).tokens)
    .toEqual({ input: 3000, cached: 2700, output: 150 });
});

test('without a rollout an unfinished attempt measures zero', () => {
  const { attempt } = fixture([...started]);
  expect(readMeasurement(attempt, { configDirectory: join(tmpdir(), 'goal-no-such-home') }).tokens).toEqual({ input: 0, cached: 0, output: 0 });
});
