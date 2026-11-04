import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import type { Actor } from '../request/access.ts';
import { ProblemError } from '../http/problem.ts';
import type { createCollectionReads } from './collection-reads.ts';
import { CollectionBulkSelectionTooLarge } from './collection-bulk-store.ts';
import type { BulkSelectionSource, BulkAdmission } from './bulk-contract.ts';

const SOURCE_PAGE_LIMIT = 100;
const SOURCE_PAGE_SIZE = 100;
const SOURCE_ROW_LIMIT = SOURCE_PAGE_LIMIT * SOURCE_PAGE_SIZE;
const TARGET_LIMIT = 1_000;

type Reads = Pick<ReturnType<typeof createCollectionReads>, 'readCollection' | 'readMembers'>;
type QuerySelection = Extract<BulkAdmission['selection'], { kind: 'query' }>;
type SourceDescriptor = {
  id: string;
  revision: number;
  membershipKind: 'curated' | 'dynamic';
  exposure: 'private' | 'unlisted' | 'public';
  sourceGeneration: string | null;
  orderEpoch: number | null;
};

export class CollectionBulkSourcePreparingError extends Error {
  constructor() {
    super('The selected source is still preparing. Retry the preview when its Members are ready.');
    this.name = 'CollectionBulkSourcePreparingError';
  }
}

function failUnavailable(): never {
  throw new ProblemError('dependency_unavailable');
}

function sourceDescriptor(value: Awaited<ReturnType<Reads['readCollection']>>): SourceDescriptor {
  if (typeof value !== 'object' || value === null) return failUnavailable();
  const row = value as unknown as Record<string, unknown>;
  const membershipKind = row.membershipKind;
  const exposure = row.visibility;
  const revision = row.revision;
  if (
    typeof row.id !== 'string' ||
    !Number.isSafeInteger(revision) ||
    (membershipKind !== 'curated' && membershipKind !== 'dynamic') ||
    (exposure !== 'private' && exposure !== 'unlisted' && exposure !== 'public')
  )
    return failUnavailable();
  const sourceGeneration = typeof row.sourceGeneration === 'string' ? row.sourceGeneration : null;
  const orderEpoch = Number.isSafeInteger(row.orderEpoch) ? (row.orderEpoch as number) : null;
  return {
    id: row.id,
    revision: revision as number,
    membershipKind,
    exposure,
    sourceGeneration,
    orderEpoch,
  };
}

function canonicalFilter(filter: string | undefined): string | null {
  if (filter === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(filter);
  } catch {
    throw new ProblemError('invalid_request', { errors: [{ pointer: '/selection/filter', code: 'invalid_format' }] });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ProblemError('invalid_request', { errors: [{ pointer: '/selection/filter', code: 'invalid_type' }] });
  const normalized = canonicalize(value);
  if (typeof normalized !== 'string')
    throw new ProblemError('invalid_request', { errors: [{ pointer: '/selection/filter', code: 'invalid_format' }] });
  return normalized;
}

function digest(value: unknown): string {
  const normalized = canonicalize(value);
  if (typeof normalized !== 'string') return failUnavailable();
  return createHash('sha256').update(normalized).digest('hex');
}

/** Capture only through the installed Collection read/Members authority. A cursor page is never treated as
 * complete: the native continuation is followed to exhaustion and the source descriptor must stay unchanged.
 */
export async function captureCollectionBulkSource(
  reads: Reads,
  actor: Actor,
  selection: QuerySelection,
  deadline: number,
): Promise<{ subjects: { subjectId: string }[]; source: BulkSelectionSource }> {
  const filter = canonicalFilter(selection.filter);
  const sort = selection.sort ?? null;
  const before = sourceDescriptor(await reads.readCollection(actor, selection.sourceId, deadline));
  if (before.id.toLowerCase() !== selection.sourceId.toLowerCase()) return failUnavailable();
  const subjects: { subjectId: string }[] = [];
  const seenSubjects = new Set<string>();
  const sourceRows: string[] = [];
  const seenCursors = new Set<string>();
  let scannedCandidates = 0;
  let cursor: string | null = null;
  let exhausted = false;

  for (let pageNo = 0; pageNo < SOURCE_PAGE_LIMIT; pageNo++) {
    const page = await reads.readMembers(
      actor,
      selection.sourceId,
      {
        limit: SOURCE_PAGE_SIZE,
        ...(cursor === null ? {} : { cursor }),
        ...(filter === null ? {} : { filter }),
        ...(sort === null ? {} : { sort }),
      },
      deadline,
    );
    if ('preparing' in page) throw new CollectionBulkSourcePreparingError();
    if (!Array.isArray(page.members) || (page.next !== null && typeof page.next !== 'string')) return failUnavailable();
    if (page.members.length > SOURCE_PAGE_SIZE) return failUnavailable();
    scannedCandidates += page.members.length;
    if (scannedCandidates > SOURCE_ROW_LIMIT) throw new ProblemError('dependency_unavailable');

    for (const member of page.members) {
      if (typeof member !== 'object' || member === null) return failUnavailable();
      const subjectId = typeof member.subjectId === 'string' ? member.subjectId.toLowerCase() : '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(subjectId))
        return failUnavailable();
      if ('id' in member && member.id !== undefined) {
        const memberId = typeof member.id === 'string' ? member.id.toLowerCase() : '';
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(memberId))
          return failUnavailable();
        sourceRows.push(`occurrence:${memberId}:${subjectId}`);
      } else sourceRows.push(`subject:${subjectId}`);
      if (!seenSubjects.has(subjectId)) {
        seenSubjects.add(subjectId);
        if (seenSubjects.size > TARGET_LIMIT) throw new CollectionBulkSelectionTooLarge();
        subjects.push({ subjectId });
      }
    }

    if (page.next === null) {
      exhausted = true;
      break;
    }
    if (page.next === cursor || seenCursors.has(page.next)) return failUnavailable();
    seenCursors.add(page.next);
    cursor = page.next;
  }
  if (!exhausted) throw new ProblemError('dependency_unavailable');

  const after = sourceDescriptor(await reads.readCollection(actor, selection.sourceId, deadline));
  if (digest(before) !== digest(after)) throw new ProblemError('stale_cursor');
  const authorityDigest = digest({
    accountId: actor.kind === 'account' ? actor.accountId : null,
    clientId: actor.kind === 'account' ? actor.clientId : null,
    requestedBy: actor.kind === 'account' ? actor.requestedBy : null,
    authnEpoch: actor.kind === 'account' ? actor.authnEpoch : null,
    scopes: actor.kind === 'account' ? [...actor.scopes].sort() : [],
  });
  const source: BulkSelectionSource = {
    id: before.id,
    revision: before.revision,
    membershipKind: before.membershipKind,
    exposure: before.exposure,
    sourceDigest: digest({
      source: before,
      viewerAuthority: authorityDigest,
      filter,
      sort,
      scannedCandidates,
      members: sourceRows,
    }),
    filter,
    sort,
    scannedCandidates,
    selectedSubjects: subjects.length,
  };
  return { subjects, source };
}
