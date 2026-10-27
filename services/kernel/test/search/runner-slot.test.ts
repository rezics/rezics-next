import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { WorkService } from '../../src/work/registry.ts';
import { createSearchRunnerSlot, type SearchRunnerControl } from './support/runner-slot.ts';

// Controlled handles observe lifecycle bookkeeping only, not indexing or source behavior.
function handle(name: string, events: string[]): SearchRunnerControl {
  const runner = {
    async stop() {
      expect(this).toBe(runner);
      events.push(`${name}:stop`);
    },
    async refresh() {
      expect(this).toBe(runner);
      events.push(`${name}:refresh`);
    },
  };
  return runner;
}

test('the controlled search slot drains and restarts only the actual registered starter', async () => {
  const events: string[] = [];
  const first = handle('first', events);
  const replacement = handle('replacement', events);
  const slot = createSearchRunnerSlot();
  let starts = 0;
  const service = slot.adopt(first, () => {
    starts += 1;
    return replacement;
  });
  expect(starts).toBe(0);
  expect(service).not.toBe(first);
  await Promise.all([slot.resume(), slot.resume()]);
  expect(starts).toBe(0);
  expect(
    await slot.withRunner(async (runner) => {
      expect(runner).toBe(first);
      await runner.refresh();
      return 42;
    }),
  ).toBe(42);
  await Promise.all([slot.pause(), slot.pause()]);
  await expect(slot.withRunner(async () => 'unreachable')).rejects.toThrow('paused');
  await Promise.all([slot.resume(), slot.resume()]);
  expect(starts).toBe(1);
  await slot.withRunner(async (runner) => {
    expect(runner).toBe(replacement);
    await runner.refresh();
  });
  await service.stop();
  expect(events).toEqual(['first:refresh', 'first:stop', 'replacement:refresh', 'replacement:stop']);
});

test('worker shutdown owns the current replacement and seals later controls', async () => {
  const events: string[] = [];
  const first = handle('first', events);
  const replacement = handle('replacement', events);
  const slot = createSearchRunnerSlot();
  const service = slot.adopt(first, () => replacement);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const rebuild = slot.withRunner(async (runner) => {
    events.push('rebuild:start');
    entered.resolve();
    await release.promise;
    await runner.refresh();
    events.push('rebuild:end');
    return 'rebuilt';
  });
  await entered.promise;
  const pause = slot.pause();
  const resume = slot.resume();
  const closing = service.stop();
  expect(slot.stop()).toBe(closing);
  expect(service.stop()).toBe(closing);
  await expect(slot.resume()).rejects.toThrow('stopped');
  await expect(slot.pause()).rejects.toThrow('stopped');
  await expect(slot.withRunner(async () => events.push('late rebuild'))).rejects.toThrow('stopped');
  expect(events).toEqual(['rebuild:start']);
  release.resolve();
  expect(await rebuild).toBe('rebuilt');
  await Promise.all([pause, resume, closing]);
  expect(events).toEqual(['rebuild:start', 'first:refresh', 'rebuild:end', 'first:stop', 'replacement:stop']);
});

test('pause drains before a queued resume starts and shutdown waits for an in-flight start', async () => {
  const events: string[] = [];
  const draining = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const starting = Promise.withResolvers<void>();
  const started = Promise.withResolvers<WorkService>();
  const slot = createSearchRunnerSlot();
  const first = {
    async refresh() {},
    async stop() {
      events.push('draining');
      draining.resolve();
      await stopped.promise;
      events.push('drained');
    },
  };
  slot.adopt(first, () => {
    events.push('starting');
    starting.resolve();
    return started.promise;
  });
  const pause = slot.pause();
  const resume = slot.resume();
  await draining.promise;
  expect(events).toEqual(['draining']);
  stopped.resolve();
  await starting.promise;
  const closing = slot.stop();
  let closed = false;
  void closing.then(() => (closed = true));
  expect(closed).toBe(false);
  started.resolve(handle('replacement', events));
  await Promise.all([pause, resume, closing]);
  expect(events).toEqual(['draining', 'drained', 'starting', 'replacement:stop']);
});

test('starter rejection keeps the slot paused and permits another captured start', async () => {
  const events: string[] = [];
  const failure = new Error('start failed');
  const slot = createSearchRunnerSlot();
  let starts = 0;
  slot.adopt(handle('first', events), async () => {
    if (++starts === 1) throw failure;
    return handle('replacement', events);
  });
  await slot.pause();
  await expect(slot.resume()).rejects.toBe(failure);
  await expect(slot.withRunner(async () => 0)).rejects.toThrow('paused');
  await slot.resume();
  await slot.stop();
  expect(starts).toBe(2);
  expect(events).toEqual(['first:stop', 'replacement:stop']);
});

test('shutdown still completes when an in-flight starter rejects', async () => {
  const events: string[] = [];
  const entered = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<WorkService>();
  const failure = new Error('start failed during close');
  const slot = createSearchRunnerSlot();
  slot.adopt(handle('first', events), () => {
    entered.resolve();
    return pending.promise;
  });
  await slot.pause();
  const resume = slot.resume();
  const rejected = resume.catch((error: unknown) => error);
  await entered.promise;
  const closing = slot.stop();
  pending.reject(failure);
  expect(await rejected).toBe(failure);
  await closing;
  expect(events).toEqual(['first:stop']);
  await expect(slot.resume()).rejects.toThrow('stopped');
});

test('operation and refresh errors keep their identity without poisoning cleanup or later controls', async () => {
  const events: string[] = [];
  const failure = new Error('rebuild failed');
  const slot = createSearchRunnerSlot();
  const first = handle('first', events);
  first.refresh = async () => {
    throw failure;
  };
  slot.adopt(first, () => handle('replacement', events));
  await expect(slot.withRunner((runner) => runner.refresh())).rejects.toBe(failure);
  await expect(
    slot.withRunner(() => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  await slot.pause();
  await slot.resume();
  await slot.stop();
  expect(events).toEqual(['first:stop', 'replacement:stop']);
});

test('failed pause retains ownership for shutdown and failed shutdown shares its rejection', async () => {
  const failure = new Error('stop failed');
  let attempts = 0;
  let starts = 0;
  const slot = createSearchRunnerSlot();
  const first = {
    async refresh() {},
    async stop() {
      attempts += 1;
      throw failure;
    },
  };
  const service = slot.adopt(first, () => {
    starts += 1;
    return first;
  });
  await expect(slot.pause()).rejects.toBe(failure);
  await slot.resume();
  expect(starts).toBe(0);
  const closing = service.stop();
  expect(slot.stop()).toBe(closing);
  await expect(closing).rejects.toBe(failure);
  expect(attempts).toBe(2);
  await expect(slot.withRunner(async () => 0)).rejects.toThrow('stopped');
});

test('invalid resumed services are cleaned up and never become the runner', async () => {
  const events: string[] = [];
  const slot = createSearchRunnerSlot();
  const malformed = {
    async stop() {
      events.push('invalid:stop');
    },
  };
  slot.adopt(handle('first', events), () => malformed);
  await slot.pause();
  await expect(slot.resume()).rejects.toThrow('refresh');
  await expect(slot.withRunner(async () => 0)).rejects.toThrow('paused');
  await slot.stop();
  expect(events).toEqual(['first:stop', 'invalid:stop']);
});

test('adoption validates both methods and cleans rejected services without replacing the starter', async () => {
  for (const malformed of [null, {}, { stop: 1 }, { stop: async () => {}, refresh: 1 }]) {
    const slot = createSearchRunnerSlot();
    expect(() => slot.adopt(malformed as WorkService, () => malformed as WorkService)).toThrow();
    await slot.stop();
  }
  const events: string[] = [];
  const slot = createSearchRunnerSlot();
  slot.adopt(handle('first', events), () => handle('replacement', events));
  expect(() => slot.adopt(handle('duplicate', events), () => handle('wrong', events))).toThrow('adopt');
  await slot.pause();
  await slot.resume();
  await slot.stop();
  expect(events).toEqual(['duplicate:stop', 'first:stop', 'replacement:stop']);
});

test('close before adoption rejects and drains the late service without starting it', async () => {
  const slot = createSearchRunnerSlot();
  await expect(slot.resume()).rejects.toThrow('adopt');
  await slot.stop();
  const drained = Promise.withResolvers<void>();
  let starts = 0;
  expect(() =>
    slot.adopt(
      {
        async stop() {
          drained.resolve();
        },
      },
      () => {
        starts += 1;
        throw new Error('must not start');
      },
    ),
  ).toThrow('stopped');
  await drained.promise;
  expect(starts).toBe(0);
});

test('shutdown includes a rejected adoption supplied before or during its drain', async () => {
  const events: string[] = [];
  const empty = createSearchRunnerSlot();
  const closingEmpty = empty.stop();
  expect(() => empty.adopt(handle('late', events), () => handle('unused', events))).toThrow('stopped');
  await closingEmpty;
  expect(events).toEqual(['late:stop']);

  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const slot = createSearchRunnerSlot();
  const first = handle('first', events);
  first.stop = async () => {
    entered.resolve();
    await release.promise;
    events.push('first:drained');
  };
  slot.adopt(first, () => first);
  const closing = slot.stop();
  await entered.promise;
  expect(() => slot.adopt(handle('during-close', events), () => first)).toThrow('stopped');
  release.resolve();
  await closing;
  expect(events).toEqual(['late:stop', 'first:drained', 'during-close:stop']);
});

test('malformed adoption is drained and consumes the one adoption attempt', async () => {
  const events: string[] = [];
  const slot = createSearchRunnerSlot();
  const malformed = {
    async stop() {
      events.push('invalid:stop');
    },
  };
  expect(() => slot.adopt(malformed, () => malformed)).toThrow('refresh');
  expect(() => slot.adopt(handle('duplicate', events), () => malformed)).toThrow('adopt');
  await slot.stop();
  expect(events).toEqual(['invalid:stop', 'duplicate:stop']);
});

test('validation errors survive failed cleanup and shutdown retries every owned handle', async () => {
  const events: string[] = [];
  const failure = new Error('malformed cleanup failed');
  let attempts = 0;
  const malformed = {
    async stop() {
      events.push('invalid:stop');
      if (++attempts === 1) throw failure;
    },
  };
  const slot = createSearchRunnerSlot();
  slot.adopt(handle('first', events), () => malformed);
  await slot.pause();
  await expect(slot.resume()).rejects.toThrow('refresh');
  await slot.stop();
  expect(events).toEqual(['first:stop', 'invalid:stop', 'invalid:stop']);

  const second = createSearchRunnerSlot();
  second.adopt(handle('current', events), () => malformed);
  const broken = {
    async stop() {
      throw failure;
    },
  };
  expect(() => second.adopt(broken, () => broken)).toThrow('adopt');
  await expect(second.stop()).rejects.toBe(failure);
  expect(events.at(-1)).toBe('current:stop');
});

test('the test helper has no runtime import that can register kernel DBOS', () => {
  const source = readFileSync(`${import.meta.dir}/support/runner-slot.ts`, 'utf8');
  const imports = new Bun.Transpiler({ loader: 'ts', target: 'bun' }).scanImports(source);
  expect(imports).toEqual([]);
});
