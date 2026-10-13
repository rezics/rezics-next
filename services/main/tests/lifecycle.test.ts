import { expect, test } from 'bun:test';
import { createMainLifecycle } from '../src/lifecycle.ts';

function fixture(fail = false, failStop = false) {
  const calls: string[] = [];
  const worker = (name: string) => ({
    start() { calls.push(`${name}:start`); },
    stop() {
      calls.push(`${name}:stop`);
      if (failStop && name === 'labels') throw new Error('stop failed');
    },
  });
  const lifecycle = createMainLifecycle({
    templateSeek: {
      async backfill(epoch) { calls.push(`template:${epoch}`); },
      startRecovery(epoch) { calls.push(`recovery:${epoch}`); },
      async stopRecovery() { calls.push('recovery:stop'); },
    },
    notificationRealtime: worker('realtime'),
    feedWorker: worker('feed'),
    occurrenceLabelWorker: worker('labels'),
    realmPolicyRecovery: {
      ...worker('policy'),
      start() {
        calls.push('policy:start');
        if (fail) throw new Error('start failed');
      },
    },
    contentProjectionWorker: worker('content'),
    recommendationWorker: {
      ...worker('recommendation'),
      enablePublicRefresh() { calls.push('recommendation:public'); },
    },
    statementSeekWorker: worker('statements'),
  }, {
    epoch: 'epoch',
    async chapters() { calls.push('chapters'); },
    shelves(signal) {
      calls.push('shelves');
      return new Promise<void>(resolve => signal.addEventListener('abort', () => {
        calls.push('shelves:stop');
        resolve();
      }, { once: true }));
    },
    listen() { calls.push('listen'); },
    async stopListening() { calls.push('listener:stop'); },
  });
  return { lifecycle, calls };
}

const startup = [
  'realtime:start', 'template:epoch', 'chapters', 'listen', 'shelves',
  'feed:start', 'labels:start', 'policy:start', 'content:start', 'recommendation:public',
  'recommendation:start', 'statements:start', 'recovery:epoch',
];
const shutdown = [
  'recovery:stop', 'labels:stop', 'statements:stop', 'policy:stop', 'shelves:stop',
  'listener:stop', 'feed:stop', 'realtime:stop', 'recommendation:stop', 'content:stop',
];

test('Main starts configured services in the production order', async () => {
  const { lifecycle, calls } = fixture();
  await lifecycle.start();
  expect(calls).toEqual(startup);
  await lifecycle.stop();
});

test('a partial start stops every service that was entered, including the failed service', async () => {
  const { lifecycle, calls } = fixture(true);
  await expect(lifecycle.start()).rejects.toThrow('start failed');
  expect(calls).toEqual([
    ...startup.slice(0, 8), 'recovery:epoch', 'recovery:stop', 'labels:stop', 'policy:stop', 'shelves:stop',
    'listener:stop', 'feed:stop', 'realtime:stop',
  ]);
});

test('complete shutdown follows production order and can be awaited repeatedly', async () => {
  const { lifecycle, calls } = fixture();
  await lifecycle.start();
  await Promise.all([lifecycle.stop(), lifecycle.stop()]);
  expect(calls).toEqual([...startup, ...shutdown]);
});

test('shutdown finishes remaining services when one stop fails', async () => {
  const { lifecycle, calls } = fixture(false, true);
  await lifecycle.start();
  await expect(lifecycle.stop()).rejects.toThrow('Main lifecycle shutdown failed');
  expect(calls).toEqual([...startup, ...shutdown]);
});
