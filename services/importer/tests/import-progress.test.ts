import { expect, test } from 'bun:test';
import {
  createWritableProgressSink,
  ImportProgressOutputError,
  ImportProgressReporter,
} from '../src/import-progress.ts';

const signal = new AbortController();

test('slow JSONL output coalesces record updates and flushes ordered phase and terminal frames', async () => {
  const events: { sequence: number; phase: string; terminal: boolean; counts: { inputBytes: number; stagedRecords: number } }[] = [];
  let started!: () => void;
  let release!: () => void;
  const firstWrite = new Promise<void>((resolve) => (started = resolve));
  const blockedWrite = new Promise<void>((resolve) => (release = resolve));
  const reporter = new ImportProgressReporter({
    source: 'wikidata',
    mode: 'jsonl',
    tty: false,
    signal: signal.signal,
    onFailure: () => {},
    sink: {
      write(frame) {
        events.push(JSON.parse(frame) as (typeof events)[number]);
        if (events.length === 1) {
          started();
          return blockedWrite;
        }
      },
    },
  });
  const acquiring = reporter.setPhase('acquiring');
  await firstWrite;
  for (let index = 0; index < 128; index++) {
    reporter.add('inputBytes', 512);
    reporter.add('stagedRecords');
  }
  const staging = reporter.setPhase('staging');
  release();
  await Promise.all([acquiring, staging]);
  await reporter.finish('committed', 'committed');
  expect(events.map(({ sequence, phase }) => [sequence, phase])).toEqual([
    [1, 'acquiring'],
    [2, 'staging'],
    [3, 'committed'],
  ]);
  expect(events[1]!.counts).toEqual({ inputBytes: 128 * 512, stagedRecords: 128 });
  expect(events[2]!.terminal).toBe(true);
});

test('a broken progress sink exposes only a sanitized failure and invokes cancellation', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const reporter = new ImportProgressReporter({
    source: 'vndb',
    mode: 'jsonl',
    tty: false,
    signal: controller.signal,
    onFailure() {
      cancelled = true;
      controller.abort();
    },
    sink: { write: () => Promise.reject(new Error('private request body')) },
  });
  await expect(reporter.setPhase('acquiring')).rejects.toBeInstanceOf(ImportProgressOutputError);
  expect(cancelled).toBe(true);
  expect(reporter.outputFailed).toBe(true);
});

test('the writable adapter cancels a frame waiting on a slow stream callback', async () => {
  const controller = new AbortController();
  let callback: ((error?: Error | null) => void) | undefined;
  const sink = createWritableProgressSink({
    write(_frame, done) {
      callback = done;
      return false;
    },
  });
  const pending = sink.write('bounded frame\n', controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  callback?.(new Error('late stream completion'));
});
