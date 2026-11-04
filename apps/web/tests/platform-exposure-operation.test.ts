import { expect, test } from 'bun:test';
import { ExposureOperation } from '../src/platform/exposure/operation';
import { parseIntent, type Intent, type Outcome, type Page } from '../src/platform/exposure/data';

const input: Intent = { group: 'collections', action: 'open', key: 'd42544e2-c78d-4a2a-8e5b-781a913e3920', body: {} };
const unavailable: Page = { status: 'unavailable', discovery: { status: 'unavailable' } };

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
    current: unavailable,
  });
  expect((await first)?.status).toBe('recorded');
  expect(await controller.send(change)).toBeNull();
  expect(controller.review({ ...input, action: 'close' })).toBe(false);
  expect(controller.cancel()).toBe(false);
});

test('explicit retry keeps its first CSRF continuation and retirement preserves an unresolved immutable source record', async () => {
  const controller = new ExposureOperation();
  expect(controller.review(input)).toBe(true);
  const original = controller.intent;
  const tokens: string[] = [];
  const uncertain: Outcome = { status: 'uncertain', operation: original!, current: unavailable };
  expect(
    (
      await controller.send(async (_intent, token) => {
        tokens.push(token ?? '');
        return uncertain;
      }, 'csrf-original')
    )?.status,
  ).toBe('uncertain');
  expect(
    (
      await controller.send(async (_intent, token) => {
        tokens.push(token ?? '');
        return { status: 'uncertain', operation: original!, current: unavailable };
      }, 'csrf-replacement')
    )?.status,
  ).toBe('uncertain');
  expect(tokens).toEqual(['csrf-original', 'csrf-original']);
  expect(controller.intent).toBe(original);

  let finish!: (result: Outcome) => void;
  const pending = controller.send(() => new Promise<Outcome>((resolve) => (finish = resolve)), 'csrf-original');
  controller.retire();
  expect(controller.intent).toBe(original);
  expect(controller.outcome?.status).toBe('uncertain');
  expect(await controller.send(async () => ({ status: 'not-sent', current: unavailable }))).toBeNull();
  finish({ status: 'not-sent', current: unavailable });
  expect(await pending).toBeNull();
  expect(controller.intent).toBe(original);
  expect(controller.outcome?.status).toBe('uncertain');
});
