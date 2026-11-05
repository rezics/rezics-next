import { createHash } from 'node:crypto';
import { catalogueBytes, parseCatalogueJson, parseCataloguePin } from '@rezics/definitions';
import type { CatalogueMechanicalInput, CatalogueMechanicalResult } from '../semantic/definition-catalogue-types.ts';

export const CATALOGUE_MECHANICAL_REPRESENTATION = Object.freeze({
  inputBytes: 1024,
  // Up to 8192 error octets expand to six JSON bytes each; the closed
  // pin, counters, phase, digest and envelope occupy less than the remainder.
  resultBytes: 65536,
  // A decimal PostgreSQL bigint, not a JavaScript number or caller increment.
  positionMaximum: '9223372036854775807',
});
const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const fail = (): never => {
  throw new TypeError('Invalid catalogue mechanical representation');
};
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).length !== fields.length ||
    fields.some((field) => !descriptors[field] || !('value' in descriptors[field]!))
  )
    return fail();
  return value as Record<string, unknown>;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)) return fail();
  return value;
}
function root(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) return fail();
  return value;
}
function counter(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)) return fail();
  if (BigInt(value) > BigInt(CATALOGUE_MECHANICAL_REPRESENTATION.positionMaximum)) return fail();
  return value;
}
function member<T extends string>(value: unknown, members: readonly T[]): T {
  if (!members.includes(value as T)) return fail();
  return value as T;
}
function selected(input: CatalogueMechanicalInput): CatalogueMechanicalInput {
  const phase = member(input.phase, ['step', 'activation-step']);
  const common = ['format', 'root', 'episode', 'position', 'deadline', 'phase'];
  record(input, [...common, phase === 'step' ? 'buildTransactionId' : 'activationId']);
  if (input.format !== 'catalogue-mechanical-input/1' || !Number.isSafeInteger(input.deadline) || input.deadline <= 0)
    return fail();
  // Snapshot scalars so a caller cannot change the retained input after hashing.
  const value = {
    format: input.format,
    root: root(input.root),
    episode: uuid(input.episode),
    position: counter(input.position),
    deadline: input.deadline,
  };
  return phase === 'step'
    ? Object.freeze({
        ...value,
        phase,
        buildTransactionId: uuid((input as { buildTransactionId: string }).buildTransactionId),
      })
    : Object.freeze({ ...value, phase, activationId: uuid((input as { activationId: string }).activationId) });
}
/** Identity excludes mutable request data and the deadline. A changed deadline or
 * episode at the same job/position must conflict with the existing original,
 * rather than select a fresh payer. inputDigest binds all immutable operands.
 * These bytes are data for Core's receiver; this function issues no work/grant.
 */
export function catalogueMechanicalSelection(input: CatalogueMechanicalInput) {
  const value = selected(input);
  const bytes = catalogueBytes(value);
  if (bytes.length > CATALOGUE_MECHANICAL_REPRESENTATION.inputBytes) return fail();
  const job = value.phase === 'step' ? value.buildTransactionId : value.activationId;
  const originalKey = createHash('sha256')
    .update(catalogueBytes(['semantic.catalogue', 0, value.root, value.phase, job, value.position]))
    .digest('hex');
  return Object.freeze({ input: value, inputDigest: digest(bytes), originalKey });
}
function progress(input: CatalogueMechanicalInput, result: CatalogueMechanicalResult): CatalogueMechanicalResult {
  record(result, ['phase', 'progress']);
  if (result.phase !== input.phase) return fail();
  if (result.phase === 'activation-step') {
    const value = record(result.progress, ['activationId', 'state', 'pending']);
    if (input.phase !== 'activation-step' || uuid(value.activationId) !== input.activationId) return fail();
    const state = member(value.state, ['ready', 'closing', 'invalidating', 'active']);
    if (typeof value.pending !== 'boolean' || (state === 'active' && value.pending)) return fail();
    return Object.freeze({
      phase: result.phase,
      progress: Object.freeze({ activationId: input.activationId, state, pending: value.pending }),
    });
  }
  const value = record(result.progress, [
    'pin',
    'state',
    'phase',
    'steps',
    'nodes',
    'releases',
    'declarations',
    'indexed_rows',
    'examined_bytes',
    'missing_digest',
    'error',
  ]);
  const pin = parseCataloguePin(value.pin);
  if (pin.rootDigest !== input.root) return fail();
  if (value.error !== null && (typeof value.error !== 'string' || Buffer.byteLength(value.error) > 8192)) return fail();
  if (value.missing_digest !== null) root(value.missing_digest);
  const steps = counter(value.steps);
  if (BigInt(steps) < BigInt(input.position) || BigInt(steps) > BigInt(input.position) + 1n) return fail();
  return Object.freeze({
    phase: result.phase,
    progress: Object.freeze({
      pin: Object.freeze({ ...pin }),
      state: member(value.state, ['building', 'incomplete', 'refused', 'ready']),
      phase: member(value.phase, ['node', 'release', 'declaration']),
      steps,
      nodes: counter(value.nodes),
      releases: counter(value.releases),
      declarations: counter(value.declarations),
      indexed_rows: counter(value.indexed_rows),
      examined_bytes: counter(value.examined_bytes),
      missing_digest: value.missing_digest as string | null,
      error: value.error as string | null,
    }),
  });
}
/** Canonical bounded body association for Core's SAME native result transaction.
 * No receipt, event or callback is part of the selected mechanical representation.
 * The native producer must still prove commit; successful decoding alone cannot.
 */
export function encodeCatalogueMechanicalResult(
  input: CatalogueMechanicalInput,
  result: CatalogueMechanicalResult,
): Buffer {
  const selection = catalogueMechanicalSelection(input);
  const bytes = Buffer.from(
    catalogueBytes({
      format: 'catalogue-mechanical-result/1',
      inputDigest: selection.inputDigest,
      result: progress(selection.input, result),
    }),
  );
  if (bytes.length > CATALOGUE_MECHANICAL_REPRESENTATION.resultBytes) return fail();
  return bytes;
}
export function decodeCatalogueMechanicalResult(
  input: CatalogueMechanicalInput,
  bytes: Uint8Array,
): CatalogueMechanicalResult {
  if (bytes.byteLength > CATALOGUE_MECHANICAL_REPRESENTATION.resultBytes) return fail();
  const selection = catalogueMechanicalSelection(input);
  const envelope = record(parseCatalogueJson(bytes, CATALOGUE_MECHANICAL_REPRESENTATION.resultBytes), [
    'format',
    'inputDigest',
    'result',
  ]);
  if (envelope.format !== 'catalogue-mechanical-result/1' || envelope.inputDigest !== selection.inputDigest)
    return fail();
  const result = progress(selection.input, envelope.result as CatalogueMechanicalResult);
  // One stored representation and digest per result, including across restart.
  if (!encodeCatalogueMechanicalResult(selection.input, result).equals(Buffer.from(bytes))) return fail();
  return result;
}
