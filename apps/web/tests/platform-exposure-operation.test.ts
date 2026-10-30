import { expect, test } from 'bun:test';
import { ExposureOperation } from '../src/platform/exposure/operation';
import { parseIntent, type Intent, type Outcome } from '../src/platform/exposure/data';

const input: Intent = { group: 'collections', action: 'open', key: 'd42544e2-c78d-4a2a-8e5b-781a913e3920', body: {} };

test('confirmation freezes a copy, rejects newline keys, and excludes double submission synchronously', async () => {
  expect(() => parseIntent({ ...input, key: input.key + '\n' })).toThrow();
  const controller = new ExposureOperation();
  controller.review(input);
  expect(controller.intent).not.toBe(input);
  expect(Object.isFrozen(controller.intent)).toBe(true);
  expect(Object.isFrozen(controller.intent?.body)).toBe(true);
  let finish!: (value: Outcome) => void;
  let calls = 0;
  const change = (operation: Intent) => {
    calls++;
    expect(operation).toBe(controller.intent);
    return new Promise<Outcome>((resolve) => {
      finish = resolve;
    });
  };
  const first = controller.send(change);
  expect(await controller.send(change)).toBeNull();
  expect(calls).toBe(1);
  finish({
    status: 'recorded',
    operation: controller.intent!,
    receipt: { group: 'collections', open: true, changed: false },
    current: { status: 'unavailable' },
  });
  expect((await first)?.status).toBe('recorded');
  expect(await controller.send(change)).toBeNull();
  expect(controller.review({ ...input, action: 'close' })).toBe(false);
  expect(controller.cancel()).toBe(false);
});
