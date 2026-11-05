import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { measureLog, measureSessionFile } from './records.ts';

const fixture = join(import.meta.dir, 'fixtures/resumed.jsonl');

test('retained fixture accounting matches measureLog', () => {
  const text = fs.readFileSync(fixture, 'utf8');
  const options = { startedAt: '2026-10-25T00:01:00Z', endedAt: '2026-10-25T00:02:00Z' };
  expect(measureSessionFile(fixture, options)).toEqual({ measurement: measureLog(text, options), hasUsage: true });
});

test('late rollout markers preserve cumulative window accounting and final session reports', () => {
  const root = join(import.meta.dir, '../../../.temp');
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(join(root, 'late-rollout-'));
  const file = join(directory, 'session.jsonl');
  const start = '2026-10-25T01:00:00.000Z';
  const end = '2026-10-25T01:01:00.000Z';
  const usage = (input_tokens: number, cached_input_tokens: number, output_tokens: number) => ({
    input_tokens,
    cached_input_tokens,
    output_tokens,
  });
  const events = [
    { type: 'thread.started', thread_id: 'late-session' },
    { timestamp: start, type: 'turn.completed', usage: usage(9000, 8000, 900) },
    {
      timestamp: start,
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ text: 'Final report' }] },
    },
    {
      timestamp: '2026-10-25T01:00:15.000Z',
      type: 'response_item',
      payload: { type: 'command_execution', id: 'current-check', command: 'bun test' },
    },
    ...[
      [1300, 700, 150],
      [1300, 700, 150],
      [1200, 650, 140],
      [1500, 800, 200],
    ].map(([input, cached, output], index) => ({
      timestamp: `2026-10-25T01:00:${20 + index}.000Z`,
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: usage(input!, cached!, output!) } },
    })),
    {
      timestamp: '2026-10-25T01:02:00.000Z',
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: usage(9000, 8000, 900) } },
    },
  ];
  const text = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
  fs.writeFileSync(file, text);
  try {
    const options = { startedAt: start, endedAt: end, baseline: { input: 1000, cached: 400, output: 100 } };
    const measured = measureSessionFile(file, options);
    expect(measured?.measurement).toEqual(measureLog(text, options));
    expect(measured?.measurement.tokens).toEqual({ input: 500, cached: 400, output: 100 });
    expect(measured?.measurement.total).toEqual({ input: 1500, cached: 800, output: 200 });
    expect(measured?.measurement.session).toBe('late-session');
    expect(measured?.measurement.steps.check).toBe(1);
    expect(measured?.measurement.result).toBe('Final report');
    expect(measured?.hasUsage).toBe(true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a growing session file is measured from one physical traversal', () => {
  const root = join(import.meta.dir, '../../../.temp');
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(join(root, 'growing-session-'));
  const file = join(directory, 'session.jsonl');
  const initial = `${JSON.stringify({
    timestamp: '2026-10-25T01:00:00Z',
    type: 'turn.completed',
    usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 2 },
  })}\n`;
  const late = `${JSON.stringify({
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 20 } } },
  })}\n`;
  fs.writeFileSync(file, initial);
  const originalOpen = fs.openSync.bind(fs);
  const originalRead = fs.readSync.bind(fs);
  const descriptors = new Set<number>();
  let traversals = 0;
  let grew = false;
  const openSpy = spyOn(fs, 'openSync').mockImplementation(((path, flags, mode) => {
    const descriptor = originalOpen(path, flags, mode);
    if (String(path) === file && flags === 'r') {
      traversals++;
      descriptors.add(descriptor);
    }
    return descriptor;
  }) as typeof fs.openSync);
  const readSpy = spyOn(fs, 'readSync').mockImplementation(((descriptor, buffer, offset, length, position) => {
    const count = originalRead(descriptor, buffer, offset, length, position);
    if (descriptors.has(descriptor) && !grew) {
      grew = true;
      fs.appendFileSync(file, late);
    }
    return count;
  }) as typeof fs.readSync);
  try {
    const options = { startedAt: '2026-10-25T01:00:00Z', endedAt: '2026-10-25T01:01:00Z' };
    const measured = measureSessionFile(file, options);
    expect(measured?.measurement).toEqual(measureLog(initial, options));
    expect(traversals).toBe(1);
    expect(grew).toBe(true);
  } finally {
    readSpy.mockRestore();
    openSpy.mockRestore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('streamed Codex usage ledgers keep their deduplicated totals and source', () => {
  const root = join(import.meta.dir, '../../../.temp');
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(join(root, 'usage-ledger-'));
  const file = join(directory, 'session.jsonl');
  const record = {
    type: 'token_usage_record',
    timestamp: '2026-10-25T01:00:10Z',
    response_id: 'response-1',
    usage: { input_tokens: 100, cached_input_tokens: 70, output_tokens: 20 },
  };
  const text = `${JSON.stringify(record)}\n${JSON.stringify(record)}\n`;
  fs.writeFileSync(file, text);
  try {
    const options = { startedAt: '2026-10-25T01:00:00Z', endedAt: '2026-10-25T01:01:00Z' };
    const measured = measureSessionFile(file, options);
    expect(measured?.measurement).toEqual(measureLog(text, options));
    expect(measured?.measurement.tokens).toEqual({ input: 100, cached: 70, output: 20 });
    expect(measured?.measurement.usageSource).toBe('codex-session');
    expect(measured?.hasUsage).toBe(true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
