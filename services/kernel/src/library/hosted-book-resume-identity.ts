import { routeOf } from '../route/contract.ts';

/** Content's catalogue is a Post, independent of the Library session's Semantic Work. */
export type HostedBookResumeAddress = Readonly<{
  kind: 'chapter';
  publication: Readonly<{
    id: string;
    structureRevisionId: string;
    releaseRevisionId: string;
  }>;
  selection: Readonly<{
    occurrenceId: string;
    body: Readonly<{ postId: string; revisionId: string; sha256: string }>;
  }>;
}>;

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as ObjectValue)
    : null;
}

function fields(value: ObjectValue, names: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === names.length && names.every((name) => Object.hasOwn(value, name));
}

function id(value: unknown): string | null {
  if (typeof value !== 'string' || value.length !== 36) return null;
  const normalized = value.toLowerCase();
  return routeOf(normalized) === null ? null : normalized;
}

function digest(value: unknown): string | null {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null;
}

/** A reader address must pin both the publication and its source structure. No head/default selector. */
export function normalizeHostedBookResumeAddress(value: unknown): HostedBookResumeAddress | null {
  const address = object(value);
  if (!address || !fields(address, ['kind', 'publication', 'selection']) || address.kind !== 'chapter') return null;
  const publication = object(address.publication);
  const selection = object(address.selection);
  const body = selection && object(selection.body);
  if (
    !publication || !fields(publication, ['id', 'structureRevisionId', 'releaseRevisionId']) ||
    !selection || !fields(selection, ['occurrenceId', 'body']) ||
    !body || !fields(body, ['postId', 'revisionId', 'sha256'])
  ) return null;
  const catalogueId = id(publication.id);
  const structureRevisionId = id(publication.structureRevisionId);
  const releaseRevisionId = id(publication.releaseRevisionId);
  const occurrenceId = id(selection.occurrenceId);
  const postId = id(body.postId);
  const revisionId = id(body.revisionId);
  const sha256 = digest(body.sha256);
  if (!catalogueId || !structureRevisionId || !releaseRevisionId || !occurrenceId || !postId || !revisionId || !sha256)
    return null;
  const route = routeOf(catalogueId);
  if (
    routeOf(structureRevisionId) !== route || routeOf(releaseRevisionId) !== route ||
    routeOf(occurrenceId) !== route || routeOf(postId) !== routeOf(revisionId) ||
    structureRevisionId === releaseRevisionId
  ) return null;
  return {
    kind: 'chapter',
    publication: { id: catalogueId, structureRevisionId, releaseRevisionId },
    selection: { occurrenceId, body: { postId, revisionId, sha256 } },
  };
}

/** Stable placement identity survives moves; two placements of the same Post remain distinct. */
export function sameHostedBookResumeOccurrence(a: HostedBookResumeAddress, b: HostedBookResumeAddress): boolean {
  return a.publication.id === b.publication.id && a.selection.occurrenceId === b.selection.occurrenceId;
}

export function sameHostedBookResumeAddress(a: HostedBookResumeAddress, b: HostedBookResumeAddress): boolean {
  return sameHostedBookResumeOccurrence(a, b) &&
    a.publication.structureRevisionId === b.publication.structureRevisionId &&
    a.publication.releaseRevisionId === b.publication.releaseRevisionId &&
    a.selection.body.postId === b.selection.body.postId &&
    a.selection.body.revisionId === b.selection.body.revisionId &&
    a.selection.body.sha256 === b.selection.body.sha256;
}

export type HostedBookResumeSelection =
  | Readonly<{ state: 'selected'; origin: 'requested' | 'checkpoint'; address: HostedBookResumeAddress }>
  | Readonly<{ state: 'empty' | 'changed' }>
  | Readonly<{ state: 'invalid'; field: 'selection' | 'checkpoint' }>;

/** Explicit selection wins. Absence never selects a first chapter or converts a work-level scalar/locator. */
export function selectHostedBookResume(input: {
  catalogueId: string;
  requested?: unknown;
  checkpoint: unknown | null;
}): HostedBookResumeSelection {
  const requested = input.requested !== undefined;
  const value = requested ? input.requested : input.checkpoint;
  if (!requested && value === null) return { state: 'empty' };
  const address = normalizeHostedBookResumeAddress(value);
  if (!address) return { state: 'invalid', field: requested ? 'selection' : 'checkpoint' };
  const catalogueId = id(input.catalogueId);
  if (!catalogueId || address.publication.id !== catalogueId) return { state: 'changed' };
  return { state: 'selected', origin: requested ? 'requested' : 'checkpoint', address };
}

export type HostedBookResumeResolution =
  | Readonly<{ state: 'available'; address: HostedBookResumeAddress }>
  | Readonly<{ state: 'unavailable' | 'changed' }>;

/**
 * Project the native hosted_catalogue.resolve value after Content admission. No body bytes or titles are retained.
 * Unavailable slots deliberately have no target: they cannot produce an address or a substitute current body.
 */
export function resolveHostedBookResumeIdentity(
  expected: HostedBookResumeAddress,
  value: unknown,
): HostedBookResumeResolution {
  const view = object(value);
  if (
    !view || view.kind !== 'publication' || id(view.catalogueId) !== expected.publication.id ||
    id(view.revisionId) !== expected.publication.releaseRevisionId ||
    id(view.sourceRevisionId) !== expected.publication.structureRevisionId
  ) return { state: 'changed' };
  const occurrence = object(view.occurrence);
  if (!occurrence || id(occurrence.occurrenceId) !== expected.selection.occurrenceId)
    return { state: 'changed' };
  if (occurrence.availability === 'unavailable') return { state: 'unavailable' };
  if (occurrence.availability !== 'available' || occurrence.kind !== 'chapter') return { state: 'changed' };
  const target = object(occurrence.target);
  const document = object(view.document);
  if (!target || !document) return { state: 'unavailable' };
  const threadId = id(target.threadId);
  const address = normalizeHostedBookResumeAddress({
    kind: 'chapter',
    publication: expected.publication,
    selection: {
      occurrenceId: occurrence.occurrenceId,
      body: { postId: target.postId, revisionId: target.revisionId, sha256: target.sha256 },
    },
  });
  if (
    !address || !threadId || routeOf(threadId) !== routeOf(address.selection.body.postId) ||
    document.encoding !== 'base64' || digest(document.sha256) !== address.selection.body.sha256 ||
    !sameHostedBookResumeAddress(expected, address)
  ) return { state: 'changed' };
  return { state: 'available', address };
}
