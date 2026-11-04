import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';
import { changesFailure, type DetailRead, type NativeRevisionDetail } from './subject-changes';
import { termFields } from './subject-terms';

export type RevisionDetailPort = (
  client: KernelClient,
  input: {
    locale: string;
    id: string;
    revision: number;
    authorization?: string | undefined;
    session?: string | undefined;
  },
) => Promise<DetailRead>;

const uuid = v.pipe(v.string(), v.uuid());
const positive = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const verdict = v.picklist(['accept', 'reject', 'abstain']);
const reading = v.strictObject({
  decision: v.nullable(v.strictObject({ head: positive, verdict, revision: positive })),
  selected: v.boolean(),
  rank: v.nullable(v.picklist(['normal', 'preferred', 'deprecated'])),
});
const candidate = { candidate: uuid, property: v.string(), context: uuid, reading };
// Validate the delivered closed wire shape; the generated producer remains the type authority.
const detailSchema = v.strictObject({
  subject: uuid,
  revision: v.strictObject({ revision: positive, kind: v.string(), release: v.string() }),
  change: v.variant('kind', [
    v.strictObject({ kind: v.literal('record') }),
    v.strictObject({
      kind: v.literal('terms'),
      fields: v.pipe(
        v.array(v.strictObject({ field: v.picklist(termFields), languages: v.array(v.string()) })),
        v.maxLength(3),
      ),
    }),
    v.strictObject({ kind: v.literal('candidate'), ...candidate }),
    v.strictObject({ kind: v.literal('decision'), ...candidate, head: positive, verdict }),
    v.strictObject({
      kind: v.literal('adoption'),
      property: v.string(),
      context: uuid,
      head: positive,
      mode: v.picklist(['inherit', 'replace', 'suppress']),
      selection: v.pipe(
        v.array(v.strictObject({ candidate: uuid, rank: v.picklist(['normal', 'preferred']) })),
        v.maxLength(32),
      ),
    }),
  ]),
}) satisfies v.GenericSchema<NativeRevisionDetail>;

/** One exact native read. Current disclosure, including Source and erasure, stays with the producer. */
export const readSubjectRevisionDetail: RevisionDetailPort = async (client, input) => {
  if (
    !v.is(uuid, input.id) ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1 ||
    input.revision > 2147483647
  )
    return { kind: 'invalid' };
  try {
    const response = await client
      .subjects({ id: input.id })
      .revisions({ revision: input.revision })
      .get({
        headers: {
          ...(input.authorization ? { authorization: input.authorization } : {}),
          ...(input.session ? { 'rezics-session-token': input.session } : {}),
        },
        fetch: { cache: 'no-store', redirect: 'manual' },
      });
    if (response.status !== 200) return changesFailure(response.status, response.error?.value);
    const parsed = v.safeParse(detailSchema, response.data);
    if (!parsed.success) return { kind: 'unavailable' };
    const { subject, revision, change } = parsed.output;
    if (subject !== input.id || revision.revision !== input.revision) return { kind: 'unavailable' };
    const summary =
      change.kind === 'record'
        ? { kind: 'limited' as const }
        : change.kind === 'decision'
          ? {
              kind: change.kind,
              candidate: change.candidate,
              property: change.property,
              context: change.context,
              decision: change.verdict,
              head: change.head,
              reading: change.reading,
            }
          : change;
    const session = new Headers(response.headers).get('rezics-session-token') ?? input.session;
    return {
      kind: 'ready',
      detail: { id: subject, revision: revision.revision, metadata: revision, summary },
      ...(session ? { session } : {}),
    };
  } catch {
    return { kind: 'unavailable' };
  }
};
