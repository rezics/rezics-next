import type { Pool } from 'pg';
import { systemClock, type KernelClock } from '../clock.ts';
import { ProblemError } from '../http/problem.ts';
import type { Access, Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { libraryActorOf, type LibraryCoverSummary } from './contract/index.ts';
import { peekLibraryDomain } from './domain-binding.ts';
import { collectionKind, type CollectionKind } from './collection-kind.ts';

export type PresentationSelection = { presentationKind?: string | null; coverMediaId?: string | null };
export type CollectionPresentation = {
  presentationKind: CollectionKind['presentationKind'];
  presentationKindSource: CollectionKind['presentationKindSource'];
  cover: LibraryCoverSummary | null;
  coverSource: 'owner' | 'member' | 'none' | 'pending';
  coverMediaId?: string | null;
};
export type PresentationDependencies = {
  pool: Pool;
  access: Access;
  routeKey?: Uint8Array;
  clock?: KernelClock;
};

/** Syntactic admission only. Semantic existence/readability is deferred until after native authorization. */
export function presentationSelection(input: PresentationSelection): PresentationSelection {
  if (
    (input.presentationKind !== undefined &&
      input.presentationKind !== null &&
      (typeof input.presentationKind !== 'string' || input.presentationKind.includes('\0'))) ||
    (input.coverMediaId !== undefined && input.coverMediaId !== null && routeOf(input.coverMediaId) === null)
  )
    throw new ProblemError('invalid_request');
  return {
    ...(input.presentationKind === undefined ? {} : { presentationKind: input.presentationKind }),
    ...(input.coverMediaId === undefined ? {} : { coverMediaId: input.coverMediaId }),
  };
}

/** Facts and authority are independent. Each Content operation releases its own anchor before the next. */
export async function readablePresentationCover(
  dependencies: PresentationDependencies,
  actor: Actor,
  id: string,
  deadline: number,
): Promise<LibraryCoverSummary | null> {
  const domain = peekLibraryDomain();
  if (!domain) return null;
  return domain.contentPublication.readableCover({
    actor: libraryActorOf(actor),
    mediaId: id,
    deadline,
    ...(dependencies.routeKey === undefined ? {} : { routeKey: dependencies.routeKey }),
    clock: dependencies.clock ?? systemClock,
  });
}

/** Preparation returns business errors as data: exact receipts still follow current Collection authorization. */
export async function preparePresentationSelection(
  dependencies: PresentationDependencies,
  actor: Actor,
  selection: PresentationSelection,
  deadline: number,
  reviewedReleaseDigest?: string,
): Promise<ProblemError | null> {
  const domain = peekLibraryDomain();
  if (!domain) return new ProblemError('dependency_unavailable');
  if (selection.presentationKind != null) {
    const active = await domain.identityDisclosure.readActiveRelease(dependencies.pool);
    if (reviewedReleaseDigest !== undefined && active?.digest !== reviewedReleaseDigest)
      return new ProblemError('conflict');
    const types =
      active && typeof active.release === 'object' && active.release && 'types' in active.release
        ? (active.release as { types: object }).types
        : null;
    if (!active || !types || !Object.hasOwn(types, selection.presentationKind))
      return new ProblemError('invalid_request');
  }
  if (selection.coverMediaId != null) {
    const cover = await readablePresentationCover(dependencies, actor, selection.coverMediaId, deadline);
    if (!cover) return new ProblemError('not_found');
  }
  return null;
}

/** Kind presentation is immediate; ordered cover readiness keeps its independent contract. */
export function collectionPresentation(
  row: { presentationKind: string | null; memberCount: number; membershipKind?: string },
  cover: LibraryCoverSummary | null = null,
): Omit<CollectionPresentation, 'coverMediaId'> {
  const empty = row.membershipKind !== 'dynamic' && row.memberCount === 0;
  return {
    ...collectionKind(row.presentationKind),
    cover,
    coverSource: cover !== null ? 'owner' : empty ? 'none' : 'pending',
  };
}
