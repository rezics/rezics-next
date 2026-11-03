import type {
  ApplyAttempt,
  CoverageCheckpoint,
  CoverageHome,
  CoveragePrefixControl,
  HomeCoverage,
  IndexIncarnation,
  PopulationLineage,
  StructuralFence,
} from './coverage.ts';
import { subjectIndexName } from './indices.ts';

export const MAX = 9223372036854775807n;
export function requireValue(ok: unknown): asserts ok {
  if (!ok) throw new TypeError('Invalid coverage state');
}
export function object(value: unknown, keys: string): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value));
  const names = keys.split(' ');
  requireValue(Reflect.ownKeys(value).length === names.length && names.every((key) => Object.hasOwn(value, key)));
  return value as Record<string, unknown>;
}
export function integer(value: unknown, min = 1, max = 2147483647): number {
  requireValue(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max);
  return value;
}
export function text(value: unknown, max: number): string {
  requireValue(typeof value === 'string' && value.isWellFormed() && !value.includes('\0'));
  requireValue(Buffer.byteLength(value, 'utf8') > 0 && Buffer.byteLength(value, 'utf8') <= max);
  return value;
}
export function uuid(value: unknown): string {
  const id = text(value, 36);
  requireValue(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id));
  return id;
}
export function bigint(value: unknown, durable = false, min = 0n): bigint {
  if (durable) {
    requireValue(typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value));
    value = BigInt(value);
  }
  requireValue(typeof value === 'bigint' && value >= min && value <= MAX);
  return value;
}
export function prefix(value: unknown): string {
  const result = text(value, 48);
  subjectIndexName(result, 1);
  return result;
}
export function incarnation(value: unknown): IndexIncarnation {
  const v = object(value, 'prefix generation index uuid protocol consumer');
  requireValue(v.protocol === 'subject-coverage-v1');
  return {
    prefix: prefix(v.prefix),
    generation: integer(v.generation, 1, Number.MAX_SAFE_INTEGER),
    index: text(v.index, 255),
    uuid: text(v.uuid, 128),
    protocol: v.protocol,
    consumer: text(v.consumer, 63),
  };
}
export function checkpoint(value: unknown, durable = false): CoverageCheckpoint {
  const v = object(value, 'epoch position');
  return { epoch: integer(v.epoch), position: bigint(v.position, durable) };
}
export function home(value: unknown, durable = false): CoverageHome {
  const v = object(value, 'partition epoch home generation');
  return {
    partition: integer(v.partition, 0, 4095),
    epoch: integer(v.epoch),
    home: text(v.home, 128),
    generation: bigint(v.generation, durable),
  };
}
export function fence(value: unknown, durable = false): StructuralFence {
  const v = object(value, 'epoch position generation');
  return { epoch: integer(v.epoch), position: bigint(v.position, durable), generation: bigint(v.generation, durable) };
}
export function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  requireValue(choices.includes(value as T));
  return value as T;
}
export function attempt(value: unknown, durable = false): ApplyAttempt {
  const v = object(value, 'id from through source outcome checkpoint');
  const result: ApplyAttempt = {
    id: uuid(v.id),
    from: checkpoint(v.from, durable),
    through: checkpoint(v.through, durable),
    source: v.source === null ? null : home(v.source, durable),
    outcome: choice(v.outcome, ['enrolled', 'visible', 'ambiguous', 'completed', 'aborted', 'skipped']),
    checkpoint: choice(v.checkpoint, ['pending', 'advanced', 'lost', 'stopped']),
  };
  requireValue(result.from.epoch === result.through.epoch && result.from.position <= result.through.position);
  requireValue(
    ['completed', 'skipped'].includes(result.outcome) === (result.checkpoint !== 'pending') ||
      result.outcome === 'aborted',
  );
  requireValue(result.outcome !== 'aborted' || result.checkpoint === 'pending');
  requireValue(!['enrolled', 'visible', 'ambiguous'].includes(result.outcome) || result.checkpoint === 'pending');
  requireValue(!['enrolled', 'aborted', 'skipped'].includes(result.outcome) || result.source === null);
  requireValue(!['visible', 'completed'].includes(result.outcome) || result.source !== null);
  requireValue(result.source === null || result.source.epoch === result.through.epoch);
  return result;
}
export function encode(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => (typeof entry === 'bigint' ? entry.toString() : entry));
}
export function equal(a: unknown, b: unknown): boolean {
  return encode(a) === encode(b);
}
export function pair(source: CoverageHome | null, observed: StructuralFence | null): void {
  requireValue(
    observed === null ||
      (source !== null && source.epoch === observed.epoch && source.generation === observed.generation),
  );
}
export function control(value: unknown, durable = false): CoveragePrefixControl {
  const v = object(value, 'prefix revision issuedGeneration');
  return {
    prefix: prefix(v.prefix),
    revision: bigint(v.revision, durable, 1n),
    issuedGeneration: integer(v.issuedGeneration, 1, Number.MAX_SAFE_INTEGER),
  };
}
export function frontier(value: unknown): Pick<PopulationLineage, 'partition' | 'after' | 'complete'> {
  const v = object(value, 'partition after complete');
  requireValue(typeof v.complete === 'boolean');
  const partition = integer(v.partition, 0, 4096);
  const after = v.after === null ? null : uuid(v.after);
  requireValue(v.complete ? partition === 4096 && after === null : partition < 4096);
  return { partition, after, complete: v.complete };
}
export function lineageRow(value: unknown): PopulationLineage {
  const v = object(
    value,
    'prefix generation index_name index_uuid protocol consumer revision state origin population_partition population_after population_complete',
  );
  const result: PopulationLineage = {
    incarnation: incarnation({
      prefix: v.prefix,
      generation: v.generation,
      index: v.index_name,
      uuid: v.index_uuid,
      protocol: v.protocol,
      consumer: v.consumer,
    }),
    revision: bigint(v.revision, true, 1n),
    state: choice(v.state, ['populating', 'live', 'quarantined', 'retiring']),
    origin: choice(v.origin, ['created-empty', 'replay', 'audit']),
    ...frontier({ partition: v.population_partition, after: v.population_after, complete: v.population_complete }),
  };
  requireValue(result.state !== 'live' || result.complete);
  return result;
}
export function homeRow(value: unknown, physical: IndexIncarnation): HomeCoverage {
  const v = object(value, 'partition_no revision current fence verified covered_through attempt');
  const result: HomeCoverage = {
    partition: integer(v.partition_no, 0, 4095),
    incarnation: physical,
    revision: bigint(v.revision, true, 1n),
    current: v.current === null ? null : home(v.current, true),
    fence: v.fence === null ? null : fence(v.fence, true),
    verified: v.verified === null ? null : home(v.verified, true),
    coveredThrough: v.covered_through === null ? null : checkpoint(v.covered_through, true),
    attempt: v.attempt === null ? null : attempt(v.attempt, true),
  };
  pair(result.current, result.fence);
  requireValue(result.current === null || result.current.partition === result.partition);
  requireValue((result.verified === null) === (result.coveredThrough === null));
  requireValue(
    !result.verified ||
      (equal(result.verified, result.current) && result.verified.epoch === result.coveredThrough!.epoch),
  );
  requireValue(
    !result.attempt ||
      ['enrolled', 'aborted', 'skipped'].includes(result.attempt.outcome) ||
      equal(result.attempt.source, result.current),
  );
  return result;
}
