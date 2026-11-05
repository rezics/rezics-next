import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { measureLog, measureSessionFile } from './records.ts';

const fixture = join(import.meta.dir, 'fixtures/resumed.jsonl');
const tokens = (input_tokens: number, cached_input_tokens: number, output_tokens: number) => ({
  input_tokens,
  cached_input_tokens,
  output_tokens,
});
const jsonl = (events: object[]) => events.map((event) => JSON.stringify(event)).join('\n') + '\n';
function withSessionFile(run: (file: string) => void) {
  const root = join(import.meta.dir, '../../../.temp');
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(join(root, 'session-accounting-'));
  try {
    run(join(directory, 'session.jsonl'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('retained fixture and usage ledger accounting match measureLog', () => {
  const options = { startedAt: '2026-10-25T00:01:00Z', endedAt: '2026-10-25T00:02:00Z' };
  const text = fs.readFileSync(fixture, 'utf8');
  expect(measureSessionFile(fixture, options)).toEqual({ measurement: measureLog(text, options), hasUsage: true });
  withSessionFile((file) => {
    const record = { type: 'token_usage_record', response_id: 'r1', usage: tokens(100, 70, 20) };
    const ledger = jsonl([record, record]);
    fs.writeFileSync(file, ledger);
    const measured = measureSessionFile(file, options);
    expect(measured?.measurement).toEqual(measureLog(ledger, options));
    expect(measured?.measurement.usageSource).toBe('codex-session');
  });
});

test('late rollout precedence and a growing file match measureLog in one traversal', () => {
  const start = '2026-10-25T01:00:00.000Z';
  const end = '2026-10-25T01:01:00.000Z';
  const options = { startedAt: start, endedAt: end, baseline: { input: 1000, cached: 400, output: 100 } };
  const initial = jsonl([
    { type: 'thread.started', thread_id: 'late-session' },
    { timestamp: start, type: 'turn.completed', usage: tokens(9000, 8000, 900) },
    {
      timestamp: start,
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ text: 'Final report' }] },
    },
    {
      timestamp: '2026-10-25T01:00:20.000Z',
      type: 'response_item',
      payload: { type: 'command_execution', id: 'check', command: 'bun test' },
    },
    {
      timestamp: '2026-10-25T01:00:30.000Z',
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: tokens(1300, 700, 150) } },
    },
    {
      timestamp: '2026-10-25T01:01:01.000Z',
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: tokens(9000, 8000, 900) } },
    },
  ]);
  const appended = jsonl([
    {
      timestamp: end,
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: tokens(10000, 9000, 1000) } },
    },
  ]);
  withSessionFile((file) => {
    fs.writeFileSync(file, initial);
    const originalOpen = fs.openSync.bind(fs),
      originalRead = fs.readSync.bind(fs);
    const descriptors = new Set<number>();
    let traversals = 0,
      grew = false;
    const open = spyOn(fs, 'openSync').mockImplementation(((path, flags, mode) => {
      const descriptor = originalOpen(path, flags, mode);
      if (String(path) === file && flags === 'r') {
        traversals++;
        descriptors.add(descriptor);
      }
      return descriptor;
    }) as typeof fs.openSync);
    const read = spyOn(fs, 'readSync').mockImplementation(((descriptor, buffer, offset, length, position) => {
      const count = originalRead(descriptor, buffer, offset, length, position);
      if (descriptors.has(descriptor) && !grew) {
        grew = true;
        fs.appendFileSync(file, appended);
      }
      return count;
    }) as typeof fs.readSync);
    try {
      const measured = measureSessionFile(file, options);
      expect(measured?.measurement).toEqual(measureLog(initial, options));
      expect(measured?.measurement.tokens).toEqual({ input: 300, cached: 300, output: 50 });
      expect(measured?.measurement.session).toBe('late-session');
      expect(measured?.measurement.steps.check).toBe(1);
      expect(measured?.measurement.result).toBe('Final report');
      expect(traversals).toBe(1);
      expect(grew).toBe(true);
    } finally {
      read.mockRestore();
      open.mockRestore();
    }
  });
});
