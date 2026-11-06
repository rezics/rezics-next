import type { PublicFilterQueriedObservation } from './public-filter-consumer-contract.ts';

/** Durable publication pin. Resume and activation reuse this exact tuple, never a later cut. */
export type GenerationPublicationPin = Readonly<{
  job: string;
  bootstrap: string;
  queried: PublicFilterQueriedObservation;
  execution: string;
}>;

export type GenerationKeyCoverage = Readonly<{
  matched: readonly string[];
  missing: readonly string[];
  extra: readonly string[];
}>;

type Tree = [string, unknown?];

function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 65536 || value.includes('\0'))
    throw new TypeError('Invalid generation publication pin locator');
}

function queried(value: unknown): asserts value is PublicFilterQueriedObservation {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Invalid generation publication queried observation');
  const record = value as Record<string, unknown>;
  const consumer = record.consumer;
  const snapshot = record.snapshot;
  if (consumer === null || typeof consumer !== 'object' || Array.isArray(consumer))
    throw new TypeError('Invalid generation publication queried consumer');
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot))
    throw new TypeError('Invalid generation publication queried snapshot');
}

/** Tagged proof encoding retains scalar, bigint and undefined without colliding with user JSON. */
function tree(value: unknown): Tree {
  if (value === undefined) return ['undefined'];
  if (typeof value === 'bigint') return ['bigint', value.toString()];
  if (Array.isArray(value)) return ['array', value.map(tree)];
  if (value !== null && typeof value === 'object')
    return [
      'object',
      Object.keys(value)
        .sort()
        .map((key) => [key, tree((value as Record<string, unknown>)[key])]),
    ];
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return ['scalar', value];
  throw new TypeError('Invalid generation publication proof value');
}

function untree(value: Tree): unknown {
  switch (value[0]) {
    case 'undefined':
      return undefined;
    case 'bigint':
      return BigInt(value[1] as string);
    case 'array':
      return (value[1] as Tree[]).map(untree);
    case 'object':
      return Object.fromEntries((value[1] as [string, Tree][]).map(([key, entry]) => [key, untree(entry)]));
    case 'scalar':
      return value[1];
    default:
      throw new TypeError('Invalid generation publication proof encoding');
  }
}

export function encodeGenerationProofValue(value: unknown): string {
  return JSON.stringify(tree(value));
}

export function decodeGenerationProofValue(value: string): unknown {
  return untree(JSON.parse(value) as Tree);
}

export function encodeGenerationPublicationQueried(value: PublicFilterQueriedObservation): string {
  queried(value);
  return encodeGenerationProofValue(value);
}

export function decodeGenerationPublicationQueried(value: string): PublicFilterQueriedObservation {
  text(value);
  const decoded = decodeGenerationProofValue(value);
  queried(decoded);
  return decoded;
}

export function encodeGenerationPublicationPin(pin: GenerationPublicationPin): string {
  text(pin.job);
  text(pin.bootstrap);
  text(pin.execution);
  queried(pin.queried);
  return encodeGenerationProofValue({
    job: pin.job,
    bootstrap: pin.bootstrap,
    queried: pin.queried,
    execution: pin.execution,
  });
}

export function decodeGenerationPublicationPin(value: string): GenerationPublicationPin {
  text(value);
  const pin = decodeGenerationProofValue(value);
  if (pin === null || typeof pin !== 'object' || Array.isArray(pin))
    throw new TypeError('Invalid generation publication pin');
  const record = pin as Record<string, unknown>;
  text(record.job);
  text(record.bootstrap);
  text(record.execution);
  queried(record.queried);
  return {
    job: record.job,
    bootstrap: record.bootstrap,
    queried: record.queried,
    execution: record.execution,
  };
}

export function publicationPinFromNative(publication: GenerationPublicationPin): GenerationPublicationPin {
  return {
    job: publication.job,
    bootstrap: publication.bootstrap,
    queried: publication.queried,
    execution: publication.execution,
  };
}

export function sameGenerationPublicationPin(left: GenerationPublicationPin, right: GenerationPublicationPin): boolean {
  return encodeGenerationPublicationPin(left) === encodeGenerationPublicationPin(right);
}

/** Identity, body and version coverage names missing Source keys and extra engine keys independently. */
export function classifyGenerationCoverage(
  expected: readonly string[],
  observed: readonly string[],
): GenerationKeyCoverage {
  const have = new Set(observed);
  return {
    matched: expected.filter((id) => have.has(id)).sort(),
    missing: expected.filter((id) => !have.has(id)).sort(),
    extra: observed.filter((id) => !expected.includes(id)).sort(),
  };
}
