import type { Pool } from 'pg';
import { deadlineClient } from '../access/authenticate.ts';
import type { KernelClock } from '../clock.ts';
import { checkMediaObject } from '../content/cover-reference.ts';
import { decideDownload } from '../content/media.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import type { Access, Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { activeRelease } from '../semantic/definitions.ts';
import type { CoverSummary } from '../semantic/summaries.ts';

export type PresentationSelection = { presentationKind?: string | null; coverMediaId?: string | null };
export type CollectionPresentation = {
  presentationKind: string | null;
  presentationKindSource: 'owner' | 'members' | 'empty' | 'pending';
  cover: CoverSummary | null;
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
): Promise<CoverSummary | null> {
  if (!dependencies.routeKey) return null;
  const reference = await withConnection(dependencies.pool, (client) =>
    checkMediaObject(deadlineClient(client, deadline), id, 'cover'),
  );
  const variant = reference?.variants?.[0];
  if (!reference || !variant || !reference.width || !reference.height || !reference.placeholder || !reference.credit)
    return null;
  const decision = await decideDownload(
    { ...dependencies, downloadContext: { deadline, routeKey: dependencies.routeKey } },
    id,
    actor,
    `${variant.format}-${variant.width}`,
  );
  if (!decision.allowed) return null;
  // Bind the descriptor to the facts whose native variant was authorized. A changed reference is withheld.
  const current = await withConnection(dependencies.pool, (client) =>
    checkMediaObject(deadlineClient(client, deadline), id, 'cover'),
  );
  if (JSON.stringify(current) !== JSON.stringify(reference)) return null;
  return {
    media: reference.id,
    width: reference.width,
    height: reference.height,
    placeholder: reference.placeholder,
    variants: reference.variants!.map((value) => ({ ...value })),
    focalPoint: reference.focalPoint ?? null,
    credit: reference.credit,
  };
}

/** Preparation returns business errors as data: exact receipts still follow current Collection authorization. */
export async function preparePresentationSelection(
  dependencies: PresentationDependencies,
  actor: Actor,
  selection: PresentationSelection,
  deadline: number,
): Promise<ProblemError | null> {
  if (selection.presentationKind != null) {
    const active = await activeRelease(dependencies.pool);
    if (!active || !Object.hasOwn(active.release.types, selection.presentationKind))
      return new ProblemError('invalid_request');
  }
  if (selection.coverMediaId != null) {
    const cover = await readablePresentationCover(dependencies, actor, selection.coverMediaId, deadline);
    if (!cover) return new ProblemError('not_found');
  }
  return null;
}

/** Storage/response seam for the separate complete derivation and ordered preview producers.
 * Only a proved empty curated source certifies absence. No member sampling or read-time work is started here.
 */
export function collectionPresentation(
  row: { presentationKind: string | null; memberCount: number; membershipKind?: string },
  cover: CoverSummary | null = null,
): Omit<CollectionPresentation, 'coverMediaId'> {
  const empty = row.membershipKind !== 'dynamic' && row.memberCount === 0;
  return {
    presentationKind: row.presentationKind ?? null,
    presentationKindSource: row.presentationKind != null ? 'owner' : empty ? 'empty' : 'pending',
    cover,
    coverSource: cover !== null ? 'owner' : empty ? 'none' : 'pending',
  };
}
