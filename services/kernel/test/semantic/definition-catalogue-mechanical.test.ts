import { expect, test } from 'bun:test';
import { CATALOGUE_FORMAT, KIND_FORMAT, KIND_REDUCTION } from '@rezics/definitions';
import {
  catalogueMechanicalSelection,
  encodeCatalogueMechanicalResult,
  decodeCatalogueMechanicalResult,
} from '../../src/command/definition-catalogue-mechanical.ts';
import type {
  CatalogueMechanicalInput,
  CatalogueMechanicalResult,
} from '../../src/semantic/definition-catalogue-types.ts';

const root = `sha256:${'a'.repeat(64)}`;
const job = '11111111-1111-4111-8111-111111111111';
const input: CatalogueMechanicalInput = {
  format: 'catalogue-mechanical-input/1',
  phase: 'step',
  root,
  buildTransactionId: job,
  episode: job,
  position: '7',
  deadline: 2_000_000_000_000,
};
const result: Extract<CatalogueMechanicalResult, { phase: 'step' }> = {
  phase: 'step',
  progress: {
    pin: { format: CATALOGUE_FORMAT, rootDigest: root, kindSpec: KIND_FORMAT, reduction: KIND_REDUCTION },
    state: 'incomplete',
    phase: 'release',
    steps: '8',
    nodes: '1',
    releases: '0',
    declarations: '0',
    indexed_rows: '0',
    examined_bytes: '0',
    missing_digest: root,
    error: null,
  },
};

test('recreated publisher selections preserve identity while changed immutable input conflicts rather than refills', () => {
  const first = catalogueMechanicalSelection(input);
  expect(catalogueMechanicalSelection(structuredClone(input))).toEqual(first);
  const changed = catalogueMechanicalSelection({ ...input, deadline: input.deadline + 1 });
  expect(changed.originalKey).toBe(first.originalKey);
  expect(changed.inputDigest).not.toBe(first.inputDigest);
  expect(catalogueMechanicalSelection({ ...input, position: '8' }).originalKey).not.toBe(first.originalKey);
  expect(Object.isFrozen(first.input)).toBe(true);
});

test('bounded result data round trips across restart with exact root, phase and original input', () => {
  const bytes = encodeCatalogueMechanicalResult(input, result);
  expect(decodeCatalogueMechanicalResult(structuredClone(input), Buffer.from(bytes))).toEqual(result);
  expect(() => decodeCatalogueMechanicalResult({ ...input, deadline: input.deadline + 1 }, bytes)).toThrow();
  expect(() => decodeCatalogueMechanicalResult({ ...input, root: `sha256:${'b'.repeat(64)}` }, bytes)).toThrow();
  expect(() => decodeCatalogueMechanicalResult(input, Buffer.concat([bytes, Buffer.from(' ')]))).toThrow();
});

test('foreign phase, unsupported public input, oversized or skipped native positions refuse', () => {
  for (const changed of [
    { phase: 'activate' },
    { position: '08' },
    { position: '9223372036854775808' },
    { extra: true },
  ])
    expect(() => catalogueMechanicalSelection({ ...input, ...changed } as CatalogueMechanicalInput)).toThrow();
  for (const steps of ['6', '9'])
    expect(() =>
      encodeCatalogueMechanicalResult(input, { ...result, progress: { ...result.progress, steps } }),
    ).toThrow();
  expect(() =>
    encodeCatalogueMechanicalResult(input, {
      ...result,
      progress: { ...result.progress, error: 'a'.repeat(8193) },
    }),
  ).toThrow();
});

test('activation recovery keeps the exact intent and cannot report active with pending withdrawals', () => {
  const activation: CatalogueMechanicalInput = {
    format: 'catalogue-mechanical-input/1',
    phase: 'activation-step',
    root,
    activationId: job,
    episode: job,
    position: '1',
    deadline: input.deadline,
  };
  const pending: CatalogueMechanicalResult = {
    phase: 'activation-step',
    progress: { activationId: job, state: 'invalidating', pending: true },
  };
  expect(decodeCatalogueMechanicalResult(activation, encodeCatalogueMechanicalResult(activation, pending))).toEqual(
    pending,
  );
  expect(() =>
    encodeCatalogueMechanicalResult(activation, {
      ...pending,
      progress: { ...pending.progress, state: 'active' },
    }),
  ).toThrow();
  expect(() => encodeCatalogueMechanicalResult(input, pending)).toThrow();
});
