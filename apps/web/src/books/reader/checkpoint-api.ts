import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';
import { hostedId, type HostedRead } from './native-api';

const digest = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));
const revision = v.pipe(v.string(), v.regex(/^[1-9][0-9]{0,18}$/));
const position = v.strictObject({
  blockId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  offset: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(2097152)),
});
export const checkpointAddressSchema = v.strictObject({
  catalogueId: hostedId,
  publicationRevisionId: hostedId,
  occurrenceId: hostedId,
  targetRevisionId: hostedId,
  targetSha256: digest,
  documentPosition: v.nullable(position),
});
const savedAddress = { subjectId: hostedId, revision, address: checkpointAddressSchema };
const metadata = v.variant('availability', [
  v.strictObject({
    availability: v.literal('unavailable'),
    occurrenceId: hostedId,
    kind: v.picklist(['chapter', 'part', 'unknown']),
  }),
  v.strictObject({
    availability: v.literal('available'),
    occurrenceId: hostedId,
    parentId: v.nullable(hostedId),
    position: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    kind: v.literal('chapter'),
    title: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
    target: v.strictObject({ threadId: hostedId, postId: hostedId, revisionId: hostedId, sha256: digest }),
  }),
]);
const responseSchema = v.variant('state', [
  v.strictObject({ state: v.literal('none'), subjectId: hostedId }),
  v.strictObject({
    state: v.literal('saved'),
    ...savedAddress,
    metadata,
  }),
]);
type WireView = NonNullable<Awaited<ReturnType<KernelClient['libraryHostedReading']['metadata']['get']>>['data']>;
export type CheckpointAddress = Extract<WireView, { state: 'saved' }>['address'];
/** The metadata response contains no body; the browser needs only its exact address and availability. */
export type CheckpointView =
  | { state: 'none'; subjectId: string }
  | {
      state: 'saved';
      subjectId: string;
      revision: string;
      address: CheckpointAddress;
      resume: { availability: 'available'; title: string } | { availability: 'unavailable' };
    };
export const checkpointCommandSchema = v.variant('kind', [
  v.strictObject({
    kind: v.literal('save'),
    subjectId: hostedId,
    address: checkpointAddressSchema,
    expectedRevision: v.nullable(revision),
  }),
  v.strictObject({ kind: v.literal('clear'), subjectId: hostedId, expectedRevision: revision }),
]);
export type CheckpointCommand = v.InferOutput<typeof checkpointCommandSchema>;
export type CheckpointWrite = HostedRead<CheckpointView> | { state: 'conflict' | 'uncertain' };

export async function readHostedCheckpoint(
  client: KernelClient,
  authorization: string,
  subjectId: string,
  signal: AbortSignal,
): Promise<HostedRead<CheckpointView>> {
  const result = await client.libraryHostedReading.metadata.get({
    query: { subjectId },
    headers: { authorization },
    fetch: { signal, cache: 'no-store', redirect: 'manual' },
  });
  if (result.status === 401 || result.status === 403) return { state: 'denied' };
  if (result.status !== 200 || result.error) return { state: 'unavailable' };
  const parsed = v.safeParse(responseSchema, result.data);
  if (!parsed.success || parsed.output.subjectId !== subjectId) return { state: 'unavailable' };
  const value: WireView = parsed.output;
  if (value.state === 'none') return { state: 'ready', value };
  const { address, metadata } = value;
  // A mismatched third-party target must never make another chapter a resume destination.
  if (
    metadata.occurrenceId !== address.occurrenceId ||
    (metadata.availability === 'available' &&
      (metadata.target.revisionId !== address.targetRevisionId || metadata.target.sha256 !== address.targetSha256))
  )
    return { state: 'unavailable' };
  return {
    state: 'ready',
    value: {
      state: 'saved',
      subjectId,
      revision: value.revision,
      address,
      resume:
        metadata.availability === 'available'
          ? { availability: 'available', title: metadata.title }
          : { availability: 'unavailable' },
    },
  };
}

/** Native CAS and idempotency remain authoritative; success requires current native readback. */
export async function writeHostedCheckpoint(
  client: KernelClient,
  authorization: string,
  command: CheckpointCommand,
  key: string,
  signal: AbortSignal,
): Promise<CheckpointWrite> {
  const options = {
    headers: { authorization, 'idempotency-key': key },
    fetch: { signal, cache: 'no-store', redirect: 'manual' } as const,
  };
  const result =
    command.kind === 'save'
      ? await client.libraryHostedReading.put(
          { ...command.address, subjectId: command.subjectId, expectedRevision: command.expectedRevision },
          options,
        )
      : await client.libraryHostedReading.$clear.post(
          { subjectId: command.subjectId, expectedRevision: command.expectedRevision },
          options,
        );
  if (result.status === 409) return { state: 'conflict' };
  if (result.status === 401 || result.status === 403) return { state: 'denied' };
  if (result.status === 400 || result.status === 404 || result.status === 422) return { state: 'changed' };
  if (result.status !== 200 || result.error) return { state: 'uncertain' };
  const schema =
    command.kind === 'save'
      ? v.strictObject(savedAddress)
      : v.strictObject({ subjectId: hostedId, cleared: v.literal(true) });
  const parsed = v.safeParse(schema, result.data);
  if (!parsed.success || parsed.output.subjectId !== command.subjectId) return { state: 'uncertain' };
  const readback = await readHostedCheckpoint(client, authorization, command.subjectId, signal);
  return readback.state === 'ready' ? readback : { state: 'uncertain' };
}
