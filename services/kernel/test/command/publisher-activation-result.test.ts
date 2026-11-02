import { expect, test } from 'bun:test';
import {
  preparePublisherActivationResult,
  decodePublisherActivationResult,
} from '../../src/command/publisher-activation-result.ts';
import type {
  CatalogueMechanicalInput,
  CatalogueMechanicalResult,
} from '../../src/semantic/definition-catalogue-types.ts';

type Input = Extract<CatalogueMechanicalInput, { phase: 'activation-step' }>;
type Result = Extract<CatalogueMechanicalResult, { phase: 'activation-step' }>;
const input: Input = {
  format: 'catalogue-mechanical-input/1',
  phase: 'activation-step',
  root: `sha256:${'a'.repeat(64)}`,
  episode: '00000000-0000-0000-0000-000000000001',
  position: '0',
  deadline: 1900000000000,
  activationId: '00000000-0000-0000-0000-000000000002',
};
const result: Result = {
  phase: 'activation-step',
  progress: { activationId: input.activationId, state: 'closing', pending: true },
};

test('canonical activation coordination bytes retain original identity across copies', () => {
  const prepared = preparePublisherActivationResult(input, result);
  const restarted = { ...prepared, bytes: new Uint8Array(prepared.bytes) };
  expect(decodePublisherActivationResult(input, restarted)).toEqual(result);
  expect(preparePublisherActivationResult({ ...input }, structuredClone(result))).toEqual(prepared);
  const changed = preparePublisherActivationResult({ ...input, deadline: input.deadline + 1 }, result);
  expect(changed.originalKey).toBe(prepared.originalKey);
  expect(changed.inputDigest).not.toBe(prepared.inputDigest);
  expect(() => decodePublisherActivationResult({ ...input, deadline: input.deadline + 1 }, restarted)).toThrow();
});

test('foreign phase, intent, original and modified stored bytes refuse', () => {
  const prepared = preparePublisherActivationResult(input, result);
  expect(() => preparePublisherActivationResult({ ...input, phase: 'step' } as unknown as Input, result)).toThrow();
  expect(() =>
    preparePublisherActivationResult(input, {
      ...result,
      progress: { ...result.progress, activationId: input.episode },
    }),
  ).toThrow();
  expect(() =>
    preparePublisherActivationResult(input, {
      ...result,
      progress: { ...result.progress, state: 'active', pending: true },
    }),
  ).toThrow();
  expect(() => decodePublisherActivationResult(input, { ...prepared, originalKey: 'b'.repeat(64) })).toThrow();
  const bytes = Buffer.from(prepared.bytes);
  bytes[0] = 32;
  expect(() => decodePublisherActivationResult(input, { ...prepared, bytes })).toThrow();
  expect(() => decodePublisherActivationResult(input, { ...prepared, bytes: new Uint8Array(65537) })).toThrow();
});

test('accessors, proxies and executable result payloads refuse without evaluation', () => {
  let calls = 0;
  const getter = Object.defineProperty({ ...result }, 'progress', {
    get() {
      calls++;
      return result.progress;
    },
  });
  expect(() => preparePublisherActivationResult(input, getter)).toThrow();
  const proxy = new Proxy(result, {
    ownKeys() {
      calls++;
      return [];
    },
  });
  expect(() => preparePublisherActivationResult(input, proxy)).toThrow();
  const executable = {
    ...result,
    progress: {
      ...result.progress,
      toJSON() {
        calls++;
        return {};
      },
    },
  };
  expect(() => preparePublisherActivationResult(input, executable)).toThrow();
  expect(calls).toBe(0);
});
