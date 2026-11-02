import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';
import { continueAddress } from './continue-address';
import {
  CONTINUE_LIMIT,
  continueFailure,
  continueProgress,
  type ContinueEntry,
  type ContinueResult,
  type ContinueSource,
} from './continue-source';

export type NativeContinuePage = NonNullable<Awaited<ReturnType<KernelClient['libraryContinue']['get']>>['data']>;
export type NativeContinueQuery = NonNullable<
  NonNullable<Parameters<KernelClient['libraryContinue']['get']>[0]>['query']
>;
type NativeSubject = NonNullable<NativeContinuePage['subjects'][number]['subject']>;
type NativeSession = NonNullable<NativeContinuePage['subjects'][number]['activeProgressSession']>;

const id = v.pipe(v.string(), v.uuid());
const positiveInteger = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const nullableText = v.nullable(v.string());
// Match semantic/http/summaries.ts's closed safe summary, including withheld covers and labels.
const subject: v.GenericSchema<NativeSubject> = v.strictObject({
  id,
  type: v.string(),
  types: v.array(v.string()),
  label: v.nullable(v.strictObject({ value: v.string(), language: v.string() })),
  creativeWork: v.boolean(),
  cover: v.nullable(
    v.strictObject({
      media: id,
      width: positiveInteger,
      height: positiveInteger,
      placeholder: v.strictObject({ thumbhash: v.string(), color: v.string() }),
      variants: v.array(v.strictObject({ format: v.picklist(['avif', 'webp']), width: positiveInteger })),
      focalPoint: v.nullable(v.strictObject({ x: v.pipe(v.number(), v.finite()), y: v.pipe(v.number(), v.finite()) })),
      credit: v.strictObject({
        rightsHolder: v.string(),
        via: v.strictObject({ name: v.string(), url: v.string() }),
        license: v.string(),
        obligations: v.array(v.string()),
      }),
    }),
  ),
});
const session = v.strictObject({
  id,
  subjectId: id,
  versionSubjectId: v.nullable(id),
  mode: v.picklist(['scalar_amount', 'cursor_position', 'completed_units']),
  unit: v.string(),
  total: nullableText,
  amount: nullableText,
  locator: nullableText,
  position: nullableText,
  completedUnitCount: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  state: v.literal('active'),
  revision: positiveInteger,
  startedAt: v.string(),
  completedAt: nullableText,
}) satisfies v.GenericSchema<NativeSession>;
const page = v.strictObject({
  subjects: v.pipe(
    v.array(
      v.strictObject({
        subjectId: id,
        state: nullableText,
        lastActivityAt: v.string(),
        activeProgressSession: v.nullable(session),
        subject: v.exactOptional(v.nullable(subject)),
      }),
    ),
    v.maxLength(CONTINUE_LIMIT),
  ),
  next: nullableText,
}) satisfies v.GenericSchema<NativeContinuePage>;

/** Presentation only. A missing FULL header cannot turn private progress into a card or successful empty page. */
export function presentContinuePage(value: unknown): ContinueResult {
  const parsed = v.safeParse(page, value);
  if (!parsed.success) return { state: 'unavailable' };
  const entries: ContinueEntry[] = [];
  for (const row of parsed.output.subjects) {
    if (!row.subject || row.subject.id !== row.subjectId) return { state: 'unavailable' };
    entries.push({
      subjectId: row.subjectId,
      label: row.subject.label?.value ?? '',
      ...(row.subject.label ? { language: row.subject.label.language } : {}),
      summary: row.subject,
      progress: continueProgress(row.activeProgressSession),
    });
  }
  return { state: 'loaded', entries, next: parsed.output.next };
}

/** The generated caller uses the original native owner/disclosure/cursor authority in one HTTP request. */
export const nativeContinueSource: ContinueSource = async (client, authorization, input, signal) => {
  const address = continueAddress(input);
  if (address.malformed) return { state: 'unavailable', reason: 'invalid-address' };
  if (signal?.aborted) return { state: 'unavailable' };
  const query: NativeContinueQuery = {
    limit: CONTINUE_LIMIT,
    view: 'FULL',
    ...(address.cursor === undefined ? {} : { cursor: address.cursor }),
  };
  try {
    const result = await client.libraryContinue.get({
      query,
      headers: { authorization },
      fetch: { cache: 'no-store', redirect: 'manual', ...(signal ? { signal } : {}) },
    });
    if (result.status !== 200 || result.error)
      return continueFailure(result.status, new Headers(result.headers).get('retry-after'), result.error?.value);
    return presentContinuePage(result.data);
  } catch {
    return { state: 'unavailable' };
  }
};
