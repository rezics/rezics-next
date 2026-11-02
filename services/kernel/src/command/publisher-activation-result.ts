import { createHash } from 'node:crypto';
import { types } from 'node:util';
import {
  catalogueMechanicalSelection,
  encodeCatalogueMechanicalResult,
  decodeCatalogueMechanicalResult,
  CATALOGUE_MECHANICAL_REPRESENTATION,
} from '../semantic/definition-catalogue-mechanical.ts';
import type { CatalogueMechanicalInput, CatalogueMechanicalResult } from '../semantic/definition-catalogue-types.ts';

type ActivationInput = Extract<CatalogueMechanicalInput, { phase: 'activation-step' }>;
type ActivationResult = Extract<CatalogueMechanicalResult, { phase: 'activation-step' }>;

function refuse(): never {
  throw new TypeError('Invalid publisher activation coordination result');
}

/** Inspect before invoking foreign code. No proxy/getter/serializer may execute
 * while Core snapshots a prospective durable association. */
function record(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return refuse();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return refuse();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || keys.some((key) => typeof key !== 'string' || !names.includes(key)))
    return refuse();
  const fields = Object.getOwnPropertyDescriptors(value);
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    const field = fields[name];
    if (!field || !('value' in field)) return refuse();
    snapshot[name] = field.value;
  }
  return snapshot;
}

function inputSnapshot(input: ActivationInput): ActivationInput {
  const value = record(input, ['format', 'root', 'episode', 'position', 'deadline', 'phase', 'activationId']);
  // Bound primitives before the foreign canonical encoder sees them.
  if (
    value.format !== 'catalogue-mechanical-input/1' ||
    value.phase !== 'activation-step' ||
    typeof value.root !== 'string' || value.root.length !== 71 ||
    typeof value.episode !== 'string' || value.episode.length !== 36 ||
    typeof value.activationId !== 'string' || value.activationId.length !== 36 ||
    typeof value.position !== 'string' || value.position.length > 19 ||
    typeof value.deadline !== 'number'
  ) return refuse();
  return catalogueMechanicalSelection(value as ActivationInput).input as ActivationInput;
}

function resultSnapshot(input: ActivationInput, result: ActivationResult): ActivationResult {
  const value = record(result, ['phase', 'progress']);
  const progress = record(value.progress, ['activationId', 'state', 'pending']);
  if (
    value.phase !== 'activation-step' ||
    progress.activationId !== input.activationId ||
    !['ready', 'closing', 'invalidating', 'active'].includes(progress.state as string) ||
    typeof progress.pending !== 'boolean'
  ) return refuse();
  return { phase: 'activation-step', progress: progress as ActivationResult['progress'] };
}

/** Representation only: no transaction, admission, ticket, noEffect authority or
 * committed proof is created here. The native producer must atomically bind these
 * bytes to its admitted original, spent ticket and actual partition fence.
 * Semantic's representation costs remain a separate owner operand. */
export function preparePublisherActivationResult(input: ActivationInput, result: ActivationResult) {
  const selected = inputSnapshot(input);
  const selection = catalogueMechanicalSelection(selected);
  const bytes = encodeCatalogueMechanicalResult(selected, resultSnapshot(selected, result));
  return Object.freeze({
    originalKey: selection.originalKey,
    inputDigest: selection.inputDigest,
    resultDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    bytes,
  });
}

/** Check canonical stored bytes against the selected original and immutable input.
 * This is not a resolver: a caller buffer is never evidence of commit. */
export function decodePublisherActivationResult(
  input: ActivationInput,
  association: Readonly<{ originalKey: string; inputDigest: string; resultDigest: string; bytes: Uint8Array }>,
): ActivationResult {
  const selected = inputSnapshot(input);
  const selection = catalogueMechanicalSelection(selected);
  const stored = record(association, ['originalKey', 'inputDigest', 'resultDigest', 'bytes']);
  if (
    stored.originalKey !== selection.originalKey ||
    stored.inputDigest !== selection.inputDigest ||
    !(stored.bytes instanceof Uint8Array) || types.isProxy(stored.bytes) ||
    stored.bytes.byteLength > CATALOGUE_MECHANICAL_REPRESENTATION.resultBytes
  ) return refuse();
  const bytes = Buffer.from(stored.bytes);
  if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== stored.resultDigest) return refuse();
  return decodeCatalogueMechanicalResult(selected, bytes) as ActivationResult;
}
