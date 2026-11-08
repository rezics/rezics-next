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
