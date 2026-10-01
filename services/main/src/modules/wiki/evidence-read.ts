import type { WorkReadSession } from '../work/read-session.ts';
import { readingBoundary, type ReadingBoundary } from '../reading-position/boundary.ts';
import { targetSummaries } from '../target/resolve.ts';
import { withholdPassage, type WikiEvidenceRow } from './evidence.ts';

export const WIKI_CLAIM_READ_COST = {
  claims: 100,
  workBatch: 50,
  evidenceQueriesPerBatch: 1,
} as const;

/** A published citation supplies provenance, not an editorial acceptance or a
 * semantic grant. Its public Work and the shared audience/position boundary
 * disclose the claim together. Callers still check active heads and references. */
export async function readWikiClaimEvidence(
  session: WorkReadSession,
  claims: readonly string[],
  kind: 'statement' | 'relation',
  boundary: ReadingBoundary = readingBoundary(session),
) {
  const evidence = (await session.deps.wikiEvidence?.forClaims(claims, kind)) ?? [];
  const works = [...new Set(evidence.map((row) => row.sourceWork))];
  const publicWorks = new Set<string>();
  for (let at = 0; at < works.length; at += WIKI_CLAIM_READ_COST.workBatch) {
    for (const summary of (
      await targetSummaries(session, works.slice(at, at + WIKI_CLAIM_READ_COST.workBatch))
    ).summaries) {
      if (
        summary.status === 'available' &&
        summary.type === 'work' &&
        summary.disclosure === 'public'
      ) {
        publicWorks.add(summary.reference);
      }
    }
  }
  const candidates = evidence.filter((row) => row.claim && publicWorks.has(row.sourceWork));
  const decisions = candidates.length
    ? await session.disclosure(
        candidates.map((row) => ({
          owner: 'graph',
          resource: row.claim!,
          component: 'record',
          work: row.sourceWork,
        })),
      )
    : [];
  const disclosed = candidates.filter((_, index) => decisions[index] === 'visible');
  const visible = await boundary.visible([...new Set(disclosed.map((row) => row.claim!))]);
  const byClaim = new Map<string, WikiEvidenceRow[]>();
  for (const row of disclosed)
    if (visible.has(row.claim!)) {
      byClaim.set(row.claim!, [...(byClaim.get(row.claim!) ?? []), row]);
    }
  return byClaim;
}

/** Rights can remove passage text without removing the locator/provenance. */
export async function projectWikiEvidence(
  session: WorkReadSession,
  rows: readonly WikiEvidenceRow[],
) {
  if (!rows.length) return [];
  const withheld =
    (await session.deps.wikiEvidence?.withheld(
      rows.map((row) => row.id),
      session.deps.rights?.store,
    )) ?? new Set(rows.map((row) => row.id));
  return rows.map((row) => ({
    id: row.id,
    sourceWork: row.sourceWork,
    representationSha256: row.representationSha256,
    locator: withheld.has(row.id) ? withholdPassage(row.locator) : row.locator,
    quote: withheld.has(row.id) ? null : row.quote,
    quoteWithheld: withheld.has(row.id),
    method: row.method,
    modality: row.modality,
    submitter: row.submitter,
    rightsBasis: row.rightsBasis,
  }));
}
