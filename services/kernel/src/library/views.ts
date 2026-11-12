import { memoizedValue } from '../memoized.ts';
import { t } from 'elysia';
import type { TObject, TProperties } from 'typebox';
import type { Actor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { ContributionAttributionSchema, type ContributionAttribution } from '../access/contract/index.ts';
import { SubjectSummarySchema, type SubjectSummary } from '../semantic/contract/index.ts';
import type { LibraryEmbedding, LibraryTargetSummary, FollowingSpaceProjection } from './contract/index.ts';
import type { LibraryPresentationDependencies } from './adapters/presentation.ts';
import { requireLibraryPresentation } from './domain-binding.ts';
import { WORK_STEP_DEADLINE_MS } from './work-step-deadline.ts';

export const viewQuery = { view: t.Optional(t.Union([t.Literal('BASIC'), t.Literal('FULL')])) };
const nullableText = t.Union([t.String(), t.Null()]);
function summarySchema() {
  return memoizedValue(summarySchema, () =>
    t.Union([
      SubjectSummarySchema,
      t.Object({ id: t.String(), type: t.String(), label: t.String() }, { additionalProperties: false }),
      t.Null(),
    ]),
  );
}
const accountSchema = t.Union([
  t.Object({ id: t.String(), handle: nullableText, displayName: nullableText }, { additionalProperties: false }),
  t.Null(),
]);
export function subjectFields() {
  return memoizedValue(subjectFields, () => ({ subject: t.Optional(summarySchema()) }));
}
export function sessionFields() {
  return memoizedValue(sessionFields, () => ({ ...subjectFields(), versionSubject: t.Optional(summarySchema()) }));
}
export const curatorFields = { curator: t.Optional(accountSchema) };
export function logFields() {
  return memoizedValue(logFields, () => ({
    ...subjectFields(),
    account: t.Optional(accountSchema),
    attribution: t.Optional(t.Union([ContributionAttributionSchema(), t.Null()])),
  }));
}
export function targetFields() {
  return memoizedValue(targetFields, () => ({
    target: t.Optional(t.Union([summarySchema(), ContributionAttributionSchema()])),
  }));
}
/** A native page embeds a current target summary, while point recovery may add contribution attribution. */
export function summaryTargetFields() {
  return memoizedValue(summaryTargetFields, () => ({ target: t.Optional(summarySchema()) }));
}
export function embedded<S extends TProperties, F extends TProperties>(schema: TObject<S>, fields: F) {
  return t.Object({ ...schema.properties, ...fields }, { additionalProperties: false });
}
export function basicQuery<Q extends { view?: string }>({ view: _view, ...query }: Q) {
  return query;
}

type Dependencies = LibraryPresentationDependencies;

/** FULL construction and bounded reads belong to the composed Library application. */
export async function fullView<T>(
  deps: Dependencies,
  actor: Actor,
  view: string | undefined,
  body: T,
  options: Readonly<{
    deadline?: number;
    follow?: true;
    withholdChangedSource?: true;
    nativeFollowTargets?: readonly import('./contract/index.ts').NativeFollowTargetAdapter[];
    followingSpaces?: (
      actor: Actor,
      ids: readonly string[],
      deadline: number,
    ) => Promise<ReadonlyMap<string, FollowingSpaceProjection>>;
  }> = {},
) {
  // BASIC is usable without a composed runtime and never opens a reader.
  if (view !== 'FULL')
    return body as LibraryEmbedding<T, SubjectSummary | LibraryTargetSummary, ContributionAttribution>;
  const deadline = options.deadline ?? deadlineFor(WORK_STEP_DEADLINE_MS);
  return requireLibraryPresentation().fullView(deps, actor, view, body, { ...options, deadline });
}

/** Uses one native page and the original opaque sparse continuation. */
export function fullMembers(
  deps: Dependencies,
  actor: Actor,
  collectionId: string,
  options: { cursor?: string; limit?: number; languages?: readonly string[] },
  deadline: number = deadlineFor(WORK_STEP_DEADLINE_MS),
) {
  return requireLibraryPresentation().fullMembers(deps, actor, collectionId, options, deadline);
}
