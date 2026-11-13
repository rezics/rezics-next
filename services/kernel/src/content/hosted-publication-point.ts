import type { Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { ContentNotFoundError, RevisionPreconditionError } from './commands.ts';
import {
  prepareHostedPointPublicEligibility,
  type HostedPointPublicEligibility,
} from './hosted-publication-point-eligibility.ts';
import {
  selectHostedPublicationPoint,
  type HostedPointSelection,
  type HostedPointSelectionReads,
  type HostedPublicationPointInput,
} from './hosted-publication-point-selection.ts';
import { validateHostedChapterAttachments } from './hosted-chapters-attachments.ts';
import { hostedCatalogue } from './hosted-chapters-store.ts';
import type { HostedChapterTarget, HostedDependencies } from './hosted-chapters-model.ts';
import { readPostMetadata, snapshot } from './reads.ts';

export type HostedPointPreparationContext = Readonly<{ actor: Actor; deadline: number }>;

export type HostedPublicationPointPreparation = Readonly<{
  selection: HostedPointSelection;
  publicEligibility: HostedPointPublicEligibility;
  /** Run in the command finalizer before receipt and outbox writes. */
  final(): Promise<void>;
}>;

function assertHostedPointRoute(route: number, id: string): void {
  if (routeOf(id) !== route) throw new ContentNotFoundError();
}

function assertSourceTarget(target: HostedChapterTarget): void {
  const route = routeOf(target.threadId);
  if (route === null || routeOf(target.postId) !== route || routeOf(target.revisionId) !== route)
    throw new ContentNotFoundError();
}

function validatePointRoutes(route: number, operation: HostedPublicationPointInput): void {
  const input = operation.input;
  assertHostedPointRoute(route, input.expectedRevisionId);
  assertHostedPointRoute(route, input.expectedPublicationId);
  assertHostedPointRoute(route, input.occurrenceId);
  assertSourceTarget(input.target);
  if (operation.kind === 'publishChapter') {
    if (operation.input.parentId !== null) assertHostedPointRoute(route, operation.input.parentId);
    if (operation.input.beforeOccurrenceId !== null) assertHostedPointRoute(route, operation.input.beforeOccurrenceId);
    for (const ancestor of operation.input.selectedAncestors) {
      assertHostedPointRoute(route, ancestor.occurrenceId);
      if (ancestor.beforeOccurrenceId !== null) assertHostedPointRoute(route, ancestor.beforeOccurrenceId);
    }
  }
}

/** Prepare only exact point reads and changed targets. The Book store supplies
 * the snapshot-bound reader; the compatibility manifest reader is not used as
 * a publication index or copied into a point version. */
export async function prepareHostedPublicationPoint(
  deps: HostedDependencies,
  catalogueId: string,
  operation: HostedPublicationPointInput,
  reads: HostedPointSelectionReads,
  context: HostedPointPreparationContext,
): Promise<HostedPublicationPointPreparation> {
  const route = routeOf(catalogueId);
  if (route === null) throw new ContentNotFoundError();
  validatePointRoutes(route, operation);

  const catalogue = (await snapshot(deps, catalogueId, context, (client) => hostedCatalogue(client, catalogueId)))
    .value;
  if (!catalogue?.publication_id) throw new ContentNotFoundError();
  if (
    catalogue.head_revision_id !== operation.input.expectedRevisionId ||
    catalogue.publication_id !== operation.input.expectedPublicationId
  )
    throw new RevisionPreconditionError();

  const selection = await selectHostedPublicationPoint(reads, operation);
  await validateHostedChapterAttachments(deps, selection.changedPlacements, context);

  const opening = await readPostMetadata(deps, catalogue.thread_id, catalogueId, context);
  if (!opening.value || opening.value.documentKind !== 'opening') throw new ContentNotFoundError();
  const catalogueOpening: HostedChapterTarget = {
    threadId: catalogue.thread_id,
    postId: catalogueId,
    revisionId: opening.value.revisionId,
    sha256: opening.value.sha256,
  };
  const changedTargets = selection.changedPlacements.flatMap((placement) =>
    placement.kind === 'chapter' ? [placement.target] : [],
  );
  const publicEligibility = await prepareHostedPointPublicEligibility(deps, catalogueOpening, changedTargets, context);
  if (!publicEligibility) throw new ContentNotFoundError();

  return {
    selection,
    publicEligibility,
    async final() {
      if (!(await publicEligibility.final())) throw new ContentNotFoundError();
    },
  };
}
