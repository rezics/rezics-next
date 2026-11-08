import type { Actor } from '../request/access.ts';
import type { ViewerPersonalActionsReader } from '../library/adapters/index.ts';
import type { ViewerPersonalActionsPage } from '../library/contract/index.ts';
import { routeOf } from '../route/route.ts';
import type { FeedDependencies } from './feed.ts';
import type { FeedItem } from './feed-contract.ts';
import type { FeedEnrichmentPorts } from './feed-enrichment-ports.ts';

type ViewerPersonalActionInput = Parameters<ViewerPersonalActionsReader>[1][number];

/** Only explicit work cards and original review targets can supply personal operands. */
export function feedViewerReferences(items: readonly FeedItem[]): ViewerPersonalActionInput[] {
  return items.flatMap((item) => {
    if (
      item.key.owner === 'semantic' &&
      'creativeWork' in item.summary &&
      item.summary.creativeWork &&
      item.destination.kind === 'subject' &&
      item.summary.id === item.key.id &&
      item.destination.id === item.key.id &&
      routeOf(item.key.id) === item.key.route &&
      item.key.kind === item.summary.type
    )
      return [{ rowKey: item.id, subjectId: item.key.id, resourceType: item.summary.type }];
    if (item.key.owner !== 'content' || item.key.kind === 'post' || !('reviewContext' in item.summary)) return [];
    const target = item.summary.reviewContext?.target;
    return target?.state === 'available'
      ? [{ rowKey: item.id, subjectId: target.subject.id, resourceType: target.subject.kind }]
      : [];
  });
}

/** One call is one page cohort. No cached result or deduplicated raw input crosses calls. */
export async function composeFeedViewerPersonalActions(
  deps: Pick<FeedDependencies, 'pool' | 'routeKey' | 'access' | 'viewerPersonalActions'>,
  enrichment: FeedEnrichmentPorts,
  actor: Actor,
  items: readonly FeedItem[],
  deadline: number,
  languages: readonly string[],
  finalAdmission: () => Promise<readonly FeedItem[]>,
): Promise<ViewerPersonalActionsPage> {
  const references = feedViewerReferences(items);
  const subjects = await enrichment.readSubjectSummaryObservation(
    { ...deps, actor, deadline },
    [...new Set(references.map((row) => row.subjectId))],
    { languages },
  );
  const rows = references.filter((row) => {
    const subject = subjects.summaries.get(row.subjectId);
    return subject?.creativeWork && subject.id === row.subjectId && subject.type === row.resourceType;
  });
  const result: ViewerPersonalActionsPage = await deps.viewerPersonalActions(
    actor,
    rows,
    enrichment.standardQuestionId,
    deadline,
  );
  const admitted = await finalAdmission();
  if (!(await subjects.current())) return { state: 'unavailable', reason: 'currentness', retryable: true };
  if (result.state !== 'current') return result;
  const current = new Map(feedViewerReferences(admitted).map((row) => [row.rowKey, row]));
  // The native helper owns standard-question meaning, counted CURRENT votes and
  // mounted action advice. Never derive a score or create denial from other fields.
  return {
    ...result,
    rows: result.rows.filter((row) => {
      const source = current.get(row.rowKey);
      return (
        source?.subjectId === row.subjectId &&
        rows.some(
          (input) =>
            input.rowKey === row.rowKey &&
            input.subjectId === row.subjectId &&
            input.resourceType === source.resourceType,
        )
      );
    }),
  };
}
