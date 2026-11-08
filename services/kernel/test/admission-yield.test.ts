import { expect, test } from 'bun:test';
import { Admission } from '../src/http/admission.ts';

const later = () => ({ deadline: Date.now() + 5000 });
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

test('a yielded normal permit admits queued work and reacquires before the reader continues', async () => {
  const admission = new Admission({ permits: 1, reserved: 1, queue: 2 });
  const pause = gate();
  const yielded = Promise.withResolvers<void>();
  const order: string[] = [];
  const holder = admission.run('normal', later(), async (yieldPermit) => {
    order.push('before-wait');
    await yieldPermit(async () => {
      expect(admission.running.normal).toBe(0);
      yielded.resolve();
      await pause.opened;
      expect(admission.running.normal).toBe(0);
    });
    expect(admission.running.normal).toBe(1);
    order.push('after-wait');
  });

  await yielded.promise;
  await admission.run('normal', later(), async () => {
    order.push('queued-reader');
  });
  expect(order).toEqual(['before-wait', 'queued-reader']);
  expect(admission.running.normal).toBe(0);
  pause.open();
  await holder;
  expect(order).toEqual(['before-wait', 'queued-reader', 'after-wait']);
  expect(admission.running).toEqual({ normal: 0, reserved: 0 });
});

test('an aborted yielded reader leaves no active permit', async () => {
  const admission = new Admission({ permits: 1, reserved: 1, queue: 2 });
  const pause = gate();
  const entered = Promise.withResolvers<void>();
  const controller = new AbortController();
  const failure = new Error('caller aborted');
  const holder = admission.run('normal', { ...later(), signal: controller.signal }, async (yieldPermit) => {
    await yieldPermit(async () => {
      entered.resolve();
      await pause.opened;
    });
  });
  await entered.promise;
  controller.abort(failure);
  pause.open();
  await expect(holder).rejects.toBe(failure);
  expect(admission.running.normal).toBe(0);
  expect(admission.waiting).toBe(0);
});

test('a yielded reader keeps the original deadline and releases after wait failure', async () => {
  const admission = new Admission({ permits: 1, reserved: 1, queue: 2 });
  const context = later();
  await expect(
    admission.run('normal', context, async (yieldPermit) => {
      await yieldPermit(async () => {
        context.deadline = Date.now() - 1;
      });
    }),
  ).rejects.toThrow();
  expect(admission.running.normal).toBe(0);
  const failure = new Error('wait failed');
  await expect(
    admission.run('normal', later(), async (yieldPermit) => {
      await yieldPermit(async () => {
        throw failure;
      });
    }),
  ).rejects.toBe(failure);
  expect(admission.running.normal).toBe(0);
});

test('yield reacquisition queues behind work that arrived first', async () => {
  const admission = new Admission({ permits: 1, reserved: 1, queue: 3 });
  const pause = gate();
  const blocked = gate();
  const entered = Promise.withResolvers<void>();
  const blockerStarted = Promise.withResolvers<void>();
  const order: string[] = [];
  const holder = admission.run('normal', later(), async (yieldPermit) => {
    await yieldPermit(async () => {
      entered.resolve();
      await pause.opened;
    });
    order.push('resumed');
  });
  await entered.promise;
  const blocker = admission.run('normal', later(), async () => {
    blockerStarted.resolve();
    await blocked.opened;
  });
  await blockerStarted.promise;
  const earlier = admission.run('normal', later(), async () => {
    order.push('earlier');
  });
  pause.open();
  await Promise.resolve();
  blocked.open();
  await Promise.all([holder, blocker, earlier]);
  expect(order).toEqual(['earlier', 'resumed']);
  expect(admission.running.normal).toBe(0);
});

test('a job ending during an outstanding yield cannot leak a reacquired permit', async () => {
  const admission = new Admission({ permits: 1, reserved: 1, queue: 2 });
  const pause = gate();
  let pending!: Promise<unknown>;
  const failure = new Error('sibling failed');
  await expect(
    admission.run('normal', later(), (yieldPermit) => {
      pending = yieldPermit(() => pause.opened);
      throw failure;
    }),
  ).rejects.toBe(failure);
  pause.open();
  await expect(pending).rejects.toThrow('finished');
  expect(admission.running.normal).toBe(0);
  expect(admission.waiting).toBe(0);
});
