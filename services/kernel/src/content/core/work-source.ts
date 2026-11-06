import {
  CONTENT_PARTITION_COUNT,
  CONTENT_UUID_PATTERN,
  CONTENT_WORK_EPOCH_MAX,
  CONTENT_WORK_EVENT_INDEX_MAX,
  CONTENT_WORK_POSITION_MAX,
} from '../contract/index.ts';

export type ContentWorkSourceIdentity = Readonly<{
  partition: number;
  epoch: number;
  position: bigint;
}>;

const SOURCE_URN = /^urn:rezics:log:(0|[1-9][0-9]*)\.([1-9][0-9]*)$/;
const SEQUENCE = /^[0-9]{19}$/;

/** Envelope identity is a value. Route/partition matching stays with the adapter that owns routing. */
export function parseWorkSourceUrn(source: string): { partition: number; epoch: number } | null {
  const match = SOURCE_URN.exec(source);
  if (!match) return null;
  const partition = Number(match[1]);
  const epoch = Number(match[2]);
  if (
    !Number.isInteger(partition) ||
    partition < 0 ||
    partition >= CONTENT_PARTITION_COUNT ||
    !Number.isInteger(epoch) ||
    epoch > CONTENT_WORK_EPOCH_MAX
  )
    return null;
  return { partition, epoch };
}

export function admitWorkEventEnvelope(input: {
  source: string;
  id: string;
  sequence: string;
  specversion: string;
  datacontenttype: string;
}): ContentWorkSourceIdentity | null {
  const parsed = parseWorkSourceUrn(input.source);
  if (!parsed) return null;
  if (!CONTENT_UUID_PATTERN.test(input.id)) return null;
  if (!SEQUENCE.test(input.sequence)) return null;
  const position = BigInt(input.sequence);
  if (position < 1n || position > CONTENT_WORK_POSITION_MAX) return null;
  if (input.specversion !== '1.0' || input.datacontenttype !== 'application/json') return null;
  return { partition: parsed.partition, epoch: parsed.epoch, position };
}

export function admitWorkSource(input: {
  partition: number;
  epoch: number;
  eventIndex: number;
  position: string;
}): boolean {
  return (
    Number.isInteger(input.partition) &&
    input.partition >= 0 &&
    input.partition < CONTENT_PARTITION_COUNT &&
    Number.isSafeInteger(input.epoch) &&
    input.epoch >= 1 &&
    input.epoch <= CONTENT_WORK_EPOCH_MAX &&
    Number.isSafeInteger(input.eventIndex) &&
    input.eventIndex >= 0 &&
    input.eventIndex < CONTENT_WORK_EVENT_INDEX_MAX &&
    /^[1-9][0-9]{0,18}$/.test(input.position) &&
    BigInt(input.position) <= CONTENT_WORK_POSITION_MAX
  );
}

export function workerDeadline(now: number, budgetMs: number): number {
  if (!Number.isFinite(now) || !Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('Invalid worker budget');
  return now + budgetMs;
}

export function admitCollectionPartitions(
  partitions: readonly number[],
  partitionCount: number,
): boolean {
  return (
    partitions.length > 0 &&
    new Set(partitions).size === partitions.length &&
    partitions.every((partition) => Number.isInteger(partition) && partition >= 0 && partition < partitionCount)
  );
}
