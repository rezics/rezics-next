import { fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import type { AssociationEvidenceClaim, AssociationEvidenceSupportReader } from '../relation/evidence.ts';
import { projectRetainedAssociationCitation } from '../relation/evidence-citation.ts';
import type { AssociationCitation, AssociationEvidenceSelection } from '../relation/evidence-contract.ts';
import { readWikiClaimEvidence, projectWikiEvidence } from '../wiki/evidence-read.ts';
import { WorkReadMoved, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import type { SourceEvidenceSelection, SourceRetainedFieldSupportStore } from './field-support-retained.ts';
import { canonicalDigest } from './retained-record-normalization.ts';

type EvidencePosition = { id: string; citation: AssociationCitation | null };
type SupportStore = Pick<SourceRetainedFieldSupportStore, 'readEvidenceSupportWindow'>;
const unavailable = (message: string): never => { throw new WorkReadUnavailable(message); };

/** Source attaches to an exact adopted Statement, including the occurrence's
 * own assertion. Its subject and authored coverage determine the stored slot;
 * a name, selected Work or unrelated trait never substitutes for them. */
export function associationSourceEvidenceSelection(selection: AssociationEvidenceSelection,
  claim: AssociationEvidenceClaim): SourceEvidenceSelection {
  const statement = selection.claim === selection.occurrence ? claim.assertion : claim.statement;
  if (!statement || statement.subject.kind !== 'resource'
    || selection.claim !== selection.occurrence && (statement.statement !== selection.claim
      || statement.revision !== selection.claimRevision)
    || selection.claim === selection.occurrence && (statement.coverage.kind !== 'occurrence'
      || statement.coverage.occurrence !== selection.occurrence
      || statement.coverage.occurrenceRevision !== selection.revision)) {
    return unavailable('Exact native Source evidence coordinates are unavailable');
  }
  return { target: statement.subject.ref, slot: 'statement-v1#value',
    occurrence: statement.coverage.kind === 'subject-global' ? null : statement.coverage.occurrence,
    context: selection.context, component: statement.statement, revision: statement.revision };
}

/** SQL evidence owners share the enclosing read's allocation with graph reads.
 * No new duration, population limit or independent budget is introduced. */
function account(session: WorkReadSession, value: unknown): void {
  session.checkDeadline();
  const budget = fusekiReadBudget.getStore();
  if (budget) {
    budget.callsLeft -= 1;
    budget.bytesLeft -= Buffer.byteLength(JSON.stringify(value), 'utf8');
  }
  session.checkDeadline();
}

function manualClaims(selection: AssociationEvidenceSelection, claim: AssociationEvidenceClaim) {
  if (selection.claim !== selection.occurrence) {
    if (!claim.statement) return unavailable('Exact Statement evidence owner is unavailable');
    return [{ id: claim.statement.statement, kind: 'statement' as const, evidence: claim.statement.evidence }];
  }
  const evidence = claim.occurrence.kind === 'native-relation' ? claim.occurrence.state.evidence ?? []
    : claim.occurrence.state.participations.flatMap(part => part.attributionSupports.flatMap(support => support.evidence));
  return [{ id: selection.occurrence, kind: 'relation' as const, evidence },
    { id: claim.assertion.statement, kind: 'statement' as const, evidence: claim.assertion.evidence }];
}

/** The existing Source and Wiki readers own native acknowledgements, current
 * disclosure and quotation rights. Retained and manual citations keep their
 * actual identities and separate contracts; manual evidence needs no conversion.
 * The complete selected inventory is fenced, including empty and withheld
 * positions. Exhausting the existing session budget refuses this read. */
export class SourceAssociationEvidenceOwner implements AssociationEvidenceSupportReader {
  private readonly inventories = new WeakMap<WorkReadSession,
    { key: string; entries: EvidencePosition[] }>();
  constructor(private readonly source: SupportStore) {}

  private async inventory(session: WorkReadSession, selection: AssociationEvidenceSelection,
    claim: AssociationEvidenceClaim) {
    const coordinates = associationSourceEvidenceSelection(selection, claim);
    if (!session.deps.wikiEvidence) return unavailable('Manual association evidence owner is unavailable');
    const entries: EvidencePosition[] = [];
    const manual: unknown[] = [];
    for (const selected of manualClaims(selection, claim)) {
      session.checkDeadline();
      const rows = await session.deps.wikiEvidence.forClaims([selected.id], selected.kind);
      account(session, rows);
      const shown = (await readWikiClaimEvidence(session, [selected.id], selected.kind)).get(selected.id) ?? [];
      const citations = await projectWikiEvidence(session, shown);
      account(session, citations);
      const ids = new Set(selected.evidence);
      const projected = new Map(citations.map(citation => [citation.id, citation]));
      const exact = rows.filter(row => ids.has(row.id));
      manual.push({ selected, rows: exact, citations: citations.filter(citation => ids.has(citation.id)) });
      for (const row of exact) entries.push({ id: row.id, citation: projected.get(row.id) ?? null });
    }
    let after: { generation: string; after: string } | undefined;
    let generation: string | undefined;
    const source: unknown[] = [];
    do {
      session.checkDeadline();
      const window = await this.source.readEvidenceSupportWindow(session, coordinates, after, 16);
      account(session, window);
      if (generation !== undefined && window.generation !== generation) {
        throw new WorkReadMoved('Source evidence inventory changed during selection');
      }
      generation = window.generation;
      source.push(window);
      for (const support of window.items) {
        if (support.evidence && support.record !== support.evidence.id) {
          return unavailable('Source evidence record differs from its support');
        }
        entries.push({ id: support.support, citation: support.evidence
          ? projectRetainedAssociationCitation({ ...support, evidence: support.evidence }) : null });
      }
      if (window.more && (!window.next || window.items.at(-1)?.support !== window.next.after
        || after && window.next.after <= after.after
        || window.next.generation !== generation) || !window.more && window.next !== null) {
        return unavailable('Source evidence physical frontier is unavailable');
      }
      after = window.next ?? undefined;
    } while (after);
    entries.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) {
      return unavailable('Association evidence support identities are ambiguous');
    }
    return { entries, token: canonicalDigest({ coordinates, generation, manual, source }) };
  }

  async basis(session: WorkReadSession, selection: AssociationEvidenceSelection, claim: AssociationEvidenceClaim) {
    const key = canonicalDigest(selection);
    const selected = await session.selection(`association-source-evidence:${key}`,
      probe => this.inventory(probe, selection, claim));
    this.inventories.set(session, { key, entries: selected.entries });
    return selected.token;
  }

  async window(session: WorkReadSession, selection: AssociationEvidenceSelection, claim: AssociationEvidenceClaim,
    after: string | null, limit: number) {
    session.checkDeadline();
    if (!Number.isInteger(limit) || limit < 1 || limit > 16) return unavailable('Invalid association evidence window');
    const key = canonicalDigest(selection);
    let selected = this.inventories.get(session);
    if (selected?.key !== key) {
      await this.basis(session, selection, claim);
      selected = this.inventories.get(session)!;
    }
    const remaining = selected.entries.filter(entry => after === null || entry.id > after);
    const physical = remaining.slice(0, limit);
    const complete = remaining.length <= limit;
    return { items: physical.flatMap(entry => entry.citation ? [structuredClone(entry.citation)] : []),
      after: complete ? null : physical.at(-1)!.id, complete };
  }
}
