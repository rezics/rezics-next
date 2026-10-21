import { READ_BASIS_RETENTION_MS } from '../read-basis/retention.ts';
import { canonicalAttribution } from './v2-schema.ts';
import { decodeReadCursor, encodeReadCursor, readDependencyToken, WorkReadExpired,
  WorkReadInvalid, WorkReadUnavailable, type ReadPosition } from '../work/read-session.ts';
import { ASSOCIATION_EVIDENCE_COST, ASSOCIATION_EVIDENCE_PROFILE, type AssociationEvidenceSelection } from './evidence-contract.ts';

export interface AssociationEvidenceBasis {
  sourcePosition: ReadPosition;
  modelGeneration: string;
  reader: unknown;
  /** Exact owner heads/adoption and current support/rights/disclosure inventory. */
  dependencies: unknown;
}
export class AssociationEvidenceCursorInvalid extends WorkReadInvalid {}
export class AssociationEvidenceChanged extends WorkReadExpired {
  readonly restart;
  constructor(selection: AssociationEvidenceSelection) {
    super('Association evidence changed; restart the selection');
    this.restart = { method: 'GET' as const, path: associationEvidencePath(selection) };
  }
}

/** This URL retains the safe selection, without a cursor or source/model pin. */
export function associationEvidencePath(selection: AssociationEvidenceSelection): string {
  const query = new URLSearchParams({ profile: ASSOCIATION_EVIDENCE_PROFILE, context: selection.context,
    position: selection.position, claim: selection.claim, claimRevision: selection.claimRevision,
    limit: String(selection.limit) });
  for (const frame of selection.frame) query.append('frame', frame);
  if (selection.actingSubject) query.set('actingSubject', selection.actingSubject);
  return `/v1/relations/${selection.occurrence.slice(selection.occurrence.lastIndexOf('/') + 1)}/revisions/${selection.revision.slice(selection.revision.lastIndexOf('/') + 1)}?${query}`;
}
const binding = (selection: AssociationEvidenceSelection, basis: Pick<AssociationEvidenceBasis, 'reader'>) =>
  [ASSOCIATION_EVIDENCE_PROFILE, canonicalAttribution(selection), readDependencyToken(basis.reader)];
const dependencies = (basis: AssociationEvidenceBasis) =>
  readDependencyToken([basis.sourcePosition, basis.modelGeneration, basis.dependencies]);
interface Frontier { after: string; dependencies: string; lastEvidence: string | null }
function frontier(value: string): Frontier {
  try {
    const row = JSON.parse(value) as Partial<Frontier>;
    if (Object.keys(row).length !== 3 || typeof row.after !== 'string' || !row.after
      || row.after.length > ASSOCIATION_EVIDENCE_COST.cursor || typeof row.dependencies !== 'string'
      || !/^[0-9a-f]{64}$/.test(row.dependencies)
      || row.lastEvidence !== null && (typeof row.lastEvidence !== 'string'
        || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(row.lastEvidence))) throw new Error('invalid frontier');
    return row as Frontier;
  } catch { throw new AssociationEvidenceCursorInvalid('Invalid association evidence cursor'); }
}

/** Reject another reader/selection before asking any claim or support owner. */
export function assertAssociationEvidenceCursorBinding(token: string | undefined,
  selection: AssociationEvidenceSelection, reader: unknown, sourcePosition: ReadPosition): void {
  if (!token) return;
  try {
    const decoded = decodeReadCursor(token, binding(selection, { reader }), sourcePosition);
    frontier(decoded!.after);
  } catch (error) {
    if (error instanceof WorkReadExpired) throw new AssociationEvidenceChanged(selection);
    if (error instanceof WorkReadInvalid) throw new AssociationEvidenceCursorInvalid('Invalid association evidence cursor');
    throw error;
  }
}

/** The frontier belongs to the existing support owner and stays encrypted. */
export function readAssociationEvidenceCursor(token: string | undefined, selection: AssociationEvidenceSelection,
  basis: AssociationEvidenceBasis): { after: string | null; lastEvidence: string | null; expiresAt: number } {
  try {
    const decoded = decodeReadCursor(token, binding(selection, basis), basis.sourcePosition);
    if (!decoded) return { after: null, lastEvidence: null, expiresAt: Date.now() + READ_BASIS_RETENTION_MS };
    const current = frontier(decoded.after);
    if (current.dependencies !== dependencies(basis)) throw new AssociationEvidenceChanged(selection);
    return { after: current.after, lastEvidence: current.lastEvidence, expiresAt: decoded.expiresAt! };
  } catch (error) {
    if (error instanceof WorkReadExpired) throw new AssociationEvidenceChanged(selection);
    if (error instanceof WorkReadInvalid) throw new AssociationEvidenceCursorInvalid('Invalid association evidence cursor');
    throw error;
  }
}
export function issueAssociationEvidenceCursor(selection: AssociationEvidenceSelection, basis: AssociationEvidenceBasis,
  after: string, expiresAt: number, lastEvidence: string | null = null): string {
  const next = JSON.stringify({ after, dependencies: dependencies(basis), lastEvidence } satisfies Frontier);
  frontier(next);
  const cursor = encodeReadCursor(binding(selection, basis), basis.sourcePosition, next, '', expiresAt);
  if (cursor.length > ASSOCIATION_EVIDENCE_COST.cursor) throw new WorkReadUnavailable('Association evidence frontier exceeds its bound');
  return cursor;
}
