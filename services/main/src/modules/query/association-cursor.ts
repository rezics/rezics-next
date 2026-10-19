import { decodeReadCursor, encodeReadCursor, readDependencyToken, WorkReadExpired,
  WorkReadInvalid, WorkReadMoved, WorkReadUnavailable } from '../work/read-session.ts';
import { READ_BASIS_RETENTION_MS } from '../read-basis/retention.ts';
import { ASSOCIATION_COST, type AssociationSelection, type AssociationSnapshot } from './association-contract.ts';
import { associationCanonical, restartAssociations } from './association-selection.ts';

export interface AssociationKey { work: string; occurrence: string; subjectParticipation: string }
export type AssociationFrontier = { kind: 'occurrence' | 'matches'; key: AssociationKey } | { kind: 'work'; work: string };
export interface AssociationReadBasis {
  snapshot: AssociationSnapshot;
  /** Verified account identity, effective actor and negotiated display policy. Never a bearer. */
  reader: unknown;
  /** Current activation/coverage, source, Context, frame and disclosure dependencies. */
  dependencies: unknown;
}
export type AssociationSurface = 'query' | 'work-credits';
export class AssociationCursorInvalid extends WorkReadInvalid {}
export class AssociationStaleQuery extends WorkReadMoved {
  readonly restart;
  constructor(selection: AssociationSelection) {
    super('Association read changed; restart the selection');
    this.restart = { method: 'POST' as const, path: '/v1/query', body: restartAssociations(selection) };
  }
}
const version = 'subject-associations-v1';
const id = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const associationOrderKey = (key: AssociationKey): string => [key.work, key.occurrence, key.subjectParticipation].join('\0');
function checkedFrontier(value: unknown): AssociationFrontier {
  if (!value || typeof value !== 'object') throw new AssociationCursorInvalid('Invalid association cursor');
  const row = value as Record<string, unknown>;
  if (row.kind === 'work' && Object.keys(row).length === 2 && typeof row.work === 'string' && id.test(row.work)) {
    return { kind: 'work', work: row.work };
  }
  if ((row.kind === 'occurrence' || row.kind === 'matches') && Object.keys(row).length === 2 && row.key && typeof row.key === 'object') {
    const key = row.key as Record<string, unknown>;
    if (Object.keys(key).length === 3 && [key.work, key.occurrence, key.subjectParticipation]
      .every(value => typeof value === 'string' && id.test(value))) return row as unknown as AssociationFrontier;
  }
  throw new AssociationCursorInvalid('Invalid association cursor');
}
const cursorBinding = (selection: AssociationSelection, basis: AssociationReadBasis, surface: AssociationSurface) =>
  [version, surface, associationCanonical(selection), associationCanonical(basis.reader)];
const cursorPosition = (basis: AssociationReadBasis) => ({
  dataEpoch: basis.snapshot.sourcePosition.dataEpoch, sequence: basis.snapshot.sourcePosition.sequence,
  // decodeReadCursor's dependency fence deliberately includes the sequence too.
  // A source/model/restore change is an explicit stale restart, never exhaustion.
  dependencyToken: readDependencyToken([basis.snapshot, basis.dependencies]),
});
export function assertAssociationSnapshot(selection: AssociationSelection, basis: AssociationReadBasis): void {
  if (selection.parameters.snapshot && associationCanonical(selection.parameters.snapshot) !== associationCanonical(basis.snapshot)) {
    throw new AssociationStaleQuery(selection);
  }
}
export function readAssociationCursor(token: string | undefined, selection: AssociationSelection,
  basis: AssociationReadBasis, surface: AssociationSurface): { frontier: AssociationFrontier | null; expiresAt: number } {
  let cursor;
  try { cursor = decodeReadCursor(token, cursorBinding(selection, basis, surface), cursorPosition(basis)); }
  catch (error) {
    if (error instanceof WorkReadExpired) throw new AssociationStaleQuery(selection);
    if (error instanceof WorkReadInvalid) throw new AssociationCursorInvalid('Invalid association cursor');
    throw error;
  }
  assertAssociationSnapshot(selection, basis);
  if (!cursor) return { frontier: null, expiresAt: Date.now() + READ_BASIS_RETENTION_MS };
  try { return { frontier: checkedFrontier(JSON.parse(cursor.after)), expiresAt: cursor.expiresAt! }; }
  catch { throw new AssociationCursorInvalid('Invalid association cursor'); }
}
export function issueAssociationCursor(selection: AssociationSelection, basis: AssociationReadBasis,
  surface: AssociationSurface, frontier: AssociationFrontier, expiresAt: number): string {
  const token = encodeReadCursor(cursorBinding(selection, basis, surface), cursorPosition(basis),
    JSON.stringify(checkedFrontier(frontier)), '', expiresAt);
  if (token.length > ASSOCIATION_COST.cursor) throw new WorkReadUnavailable('Association continuation exceeds its admitted bound');
  return token;
}

/** The encrypted matches frontier fixes one Work. An inverse request retains
 * all native/external subject roots; replacing them with a Work would change
 * the subject selection. Forward requests also narrow their explicit roots. */
export function associationMatchSelection(selection: AssociationSelection, work: string): AssociationSelection {
  return { ...selection, limit: ASSOCIATION_COST.witnesses, parameters: { ...selection.parameters,
    ...(selection.parameters.direction === 'work-to-subject' ? { roots: [{ kind: 'resource' as const, ref: work }] } : {}),
    projection: 'occurrence' } };
}
