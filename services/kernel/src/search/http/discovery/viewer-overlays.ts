import type { DiscoveryPage } from '../../discovery.ts';
import { t } from 'elysia';
import { routeOf } from '../../../route/route.ts';
import { viewerFactsResponseSchema } from '../../../library/viewer-facts.ts';
import { closed, unavailable } from './primitives.ts';
import type { DiscoveryHttpPage } from './page.ts';
const viewerFactsUnavailable = t.Object(
  {
    state: t.Literal('unavailable'),
    reason: t.Union([t.Literal('identity'), t.Literal('currentness'), t.Literal('response_limit')]),
    retryable: t.Boolean(),
  },
  closed,
);
const currentViewerFactsSchema = viewerFactsResponseSchema.anyOf[0]!;
const searchViewerFacts = t.Object(
  {
    ...currentViewerFactsSchema.properties,
    rows: t.Array(
      t.Object(
        {
          ...currentViewerFactsSchema.properties.rows.items.properties,
          resolvedSubjectId: t.Optional(t.String({ format: 'uuid' })),
        },
        closed,
      ),
      { maxItems: 100 },
    ),
  },
  closed,
);
export const viewerFacts = t.Union([t.Null(), searchViewerFacts, viewerFactsUnavailable]);

export function admitCollectionFollows(page: DiscoveryHttpPage) {
  if (page.collectionFollows?.state === 'current') {
    const collections = page.hits.flatMap((hit) => (hit.summary.kind === 'collection' ? [hit.summary.value.card] : []));
    const home = routeOf(page.collectionFollows.accountId);
    if (
      home === null ||
      home >>> 4 !== page.collectionFollows.partition ||
      page.collectionFollows.rows.length !== collections.length ||
      page.collectionFollows.rows.some((row, index) => {
        const card = collections[index]!;
        return (
          row.targetType !== 'collection' ||
          row.targetId !== card.id ||
          row.source !==
            JSON.stringify([
              card.id,
              card.sourceGeneration,
              card.revision,
              card.membershipKind,
              card.membershipKind === 'curated' ? card.orderEpoch : card.outputGeneration,
            ])
        );
      })
    )
      unavailable();
  }
}

export function admitAccountFollows(page: DiscoveryHttpPage) {
  const follows = page.accountFollows;
  if (follows?.state !== 'current') return;
  const targets = page.hits.flatMap((hit) =>
    hit.summary.kind === 'account' && hit.summary.value.context?.followTarget.state === 'available'
      ? [hit.summary.value.context.followTarget]
      : [],
  );
  const home = routeOf(follows.accountId);
  if (
    home === null ||
    home >>> 4 !== follows.partition ||
    follows.rows.length !== targets.length ||
    new Set(targets.map((target) => target.id)).size !== targets.length ||
    follows.rows.some(
      (row, index) =>
        row.targetType !== 'subject' || row.targetId !== targets[index]!.id || row.source !== targets[index]!.source,
    )
  )
    unavailable();
}

export function admitSubjectViewerFacts(page: DiscoveryHttpPage) {
  if (page.viewerFacts && page.viewerFacts !== null && page.viewerFacts.state === 'current') {
    const subjects = page.hits.filter((hit) => hit.summary.kind === 'subject');
    if (
      page.viewerFacts.rows.length !== subjects.length ||
      page.viewerFacts.rows.some(
        (row, index) =>
          row.subjectId !== subjects[index]!.key.id ||
          row.rowKey !==
            JSON.stringify([
              subjects[index]!.key.owner,
              subjects[index]!.key.kind,
              subjects[index]!.key.route,
              subjects[index]!.key.id,
            ]),
      )
    )
      unavailable();
  }
}

export function snapshotViewerOverlays(page: DiscoveryPage) {
  const accountFollows: DiscoveryHttpPage['accountFollows'] =
    page.accountFollows?.state === 'current'
      ? {
          ...page.accountFollows,
          rows: page.accountFollows.rows.map((row) => ({ ...row, actions: { ...row.actions } })),
        }
      : page.accountFollows
        ? { ...page.accountFollows }
        : undefined;
  const { viewerFacts: originalViewerFacts, collectionFollows: originalFollows } = page;
  const collectionFollows: DiscoveryHttpPage['collectionFollows'] =
    originalFollows?.state === 'current'
      ? { ...originalFollows, rows: originalFollows.rows.map((row) => ({ ...row, actions: { ...row.actions } })) }
      : originalFollows
        ? { ...originalFollows }
        : undefined;
  const viewerFacts: DiscoveryHttpPage['viewerFacts'] =
    originalViewerFacts === undefined || originalViewerFacts === null
      ? originalViewerFacts
      : originalViewerFacts.state === 'unavailable'
        ? { ...originalViewerFacts }
        : {
            state: 'current',
            question: originalViewerFacts.question
              ? { ...originalViewerFacts.question, scale: { ...originalViewerFacts.question.scale } }
              : null,
            rows: originalViewerFacts.rows.map((row) => ({
              rowKey: row.rowKey,
              subjectId: row.subjectId,
              ...(row.resolvedSubjectId ? { resolvedSubjectId: row.resolvedSubjectId } : {}),
              entry: structuredClone(row.entry),
              vote: structuredClone(row.vote),
            })),
          };
  return {
    ...(accountFollows === undefined ? {} : { accountFollows }),
    ...(viewerFacts === undefined ? {} : { viewerFacts }),
    ...(collectionFollows === undefined ? {} : { collectionFollows }),
  };
}
