import type { Pool, PoolClient } from 'pg';
import type { RightsStore } from '../rights/store.ts';
import type { VerifiedExportMember } from '../export/planner.ts';
import { canonicalCandidate, EditorialBlocked } from '../editorial-review/contract.ts';
import { ReadingPositionStore, type Revelation } from '../reading-position/store.ts';
import { derivedId } from '../structure/graph.ts';
import { extractionQuotationUses, quotationKey, WIKI_QUOTATION_POLICY } from './quotation.ts';
import type { WikiExtraction } from './protocol.ts';

export const WIKI_EVIDENCE_COST = { rows: 4096, rightsBatch: 256, statementMs: 1000,
  quotationRows: 10001, revelationRows: 4096 } as const;
export const evidenceId = (proposal: string, revision: number, claim: number, evidence: number) =>
  derivedId(`wiki-evidence-v1\0${proposal}\0${revision}\0${claim}\0${evidence}`);
export const evidenceReceipt = (proposal: string, revision: number) => `urn:rezics:wiki-evidence:${proposal}:${revision}`;
export interface WikiEvidenceRow {
  id: string; representationSha256: string; locator: unknown; quote: string;
  method: unknown; modality: string; submitter: string; rightsBasis: string; sourceWork: string;
  claim: string | null; claimKind: 'statement' | 'relation' | null;
}
export function withholdPassage(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withholdPassage);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key,child]) => [key,['quote','exact','prefix','suffix'].includes(key) ? null : withholdPassage(child)]));
  return value;
}

export class WikiEvidenceStore {
  constructor(readonly pool: Pool) {}
  private async transaction<T>(work: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = '${WIKI_EVIDENCE_COST.statementMs}ms'`);
      // Transaction locks release with commit/rollback, including process loss:
      // https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`wiki-work:${work}`]);
      const result = await operation(client);
      await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async publish(bundle: WikiExtraction, proposal: string, revision: number, submitter: string) {
    const uses = extractionQuotationUses(bundle), receipt = evidenceReceipt(proposal,revision);
    const rows = bundle.claims.flatMap((claim,c) => claim.evidence.map((evidence,e) => ({
      id: evidenceId(proposal,revision,c,e),modality: claim.modality,...evidence })));
    await this.transaction(bundle.target,async client => {
      const applied = (await client.query<{ total: string; keys: string[] | null }>(`SELECT coalesce(sum(code_points),0)::text AS total,
        array_agg(representation_sha256 || ':' || locator_digest || ':' || quote_digest) AS keys
        FROM (SELECT * FROM wiki.quotation WHERE work = $1 LIMIT 10001) quotes`,[bundle.target])).rows[0]!;
      const existing = new Set(applied.keys ?? []);
      if (Number(applied.total) + uses.reduce((n,use) => n + (existing.has(quotationKey(use)) ? 0 : use.codePoints),0)
        > WIKI_QUOTATION_POLICY.workCodePoints) throw new EditorialBlocked({ code: 'budget_exhausted' });
      if (uses.length) await client.query(`INSERT INTO wiki.quotation
        (work,representation_sha256,locator_digest,quote_digest,code_points,policy_version,applied_receipt)
        SELECT $1,r,l,q,n,1,$6 FROM unnest($2::text[],$3::text[],$4::text[],$5::int[]) AS quotes(r,l,q,n)
        ON CONFLICT DO NOTHING`,[bundle.target,uses.map(use => use.representationSha256),uses.map(use => use.locatorDigest),
      uses.map(use => use.quoteDigest),uses.map(use => use.codePoints),receipt]);
      if (rows.length) await client.query(`INSERT INTO wiki.evidence
        (id,representation_sha256,locator,quote,method,submitter,rights_basis,source_work,applied_receipt,modality)
        SELECT id,$2,locator::jsonb,quote,$5::jsonb,$6,$7,$8,$9,modality
        FROM unnest($1::text[],$3::text[],$4::text[],$10::text[]) AS evidence(id,locator,quote,modality) ON CONFLICT DO NOTHING`,
      [rows.map(row => row.id),bundle.source.representationSha256,rows.map(row => JSON.stringify(row.locator)),
        rows.map(row => row.quote),JSON.stringify(bundle.source.method),submitter,bundle.source.rightsBasis,bundle.target,receipt,rows.map(row => row.modality)]);
    });
    return { receipt,ids: rows.map(row => row.id) };
  }
  async published(proposal: string, revision: number, expected: number): Promise<boolean> {
    if (!expected) return true;
    const rows = await this.pool.query(`SELECT id FROM wiki.evidence WHERE applied_receipt = $1 LIMIT 4097`,
      [evidenceReceipt(proposal,revision)]);
    return rows.rowCount === expected;
  }
  async reveal(work: string, rows: readonly Revelation[], claims: readonly {
    evidence: string[]; claim: string; kind: 'statement' | 'relation' }[]) {
    await this.transaction(work,async client => {
      const store = new ReadingPositionStore(this.pool);
      for (const row of rows) await store.write(client,row,null);
      for (const claim of claims) {
        const result = await client.query(`UPDATE wiki.evidence SET claim = $2,claim_kind = $3
          WHERE id = ANY($1::text[]) AND (claim IS NULL OR claim = $2 AND claim_kind = $3) RETURNING id`,
        [claim.evidence,claim.claim,claim.kind]);
        if (result.rowCount !== claim.evidence.length) throw new Error('Wiki evidence claim binding changed');
      }
    });
  }
  async read(id: string): Promise<WikiEvidenceRow | null> {
    return (await this.pool.query<WikiEvidenceRow>(`SELECT id,representation_sha256 AS "representationSha256",locator,quote,
      method,modality,submitter,rights_basis AS "rightsBasis",source_work AS "sourceWork",claim,claim_kind AS "claimKind"
      FROM wiki.evidence WHERE id = $1`,[id])).rows[0] ?? null;
  }
  async withheld(ids: readonly string[], rights: Pick<RightsStore,'exportScope'> | undefined): Promise<Set<string>> {
    if (!rights) return new Set(ids);
    const withheld = new Set<string>();
    for (let at = 0; at < ids.length; at += WIKI_EVIDENCE_COST.rightsBatch) {
      const batch = ids.slice(at,at + WIKI_EVIDENCE_COST.rightsBatch);
      const members: VerifiedExportMember[] = batch.map(id => ({ sourceOwner: 'content',sourceNamespace: 'wiki',
        sourceGrain: 'evidence',exactRef: id,contentRevisionId: null,refDigest: canonicalCandidate(id).digest,
        ownerDataEpoch: 'wiki-evidence-v1',ownerSequence: '0',sourcePosition: null,targetGrain: 'evidence',mapping: 'exact',
        data: { rightsIdentity: { material: { scopeKind: 'wiki_evidence',provider: null,namespace: null,
          sourceRecordId: null,contentVariantId: null,mediaAsset: null,wikiEvidenceId: id,component: 'record' },
        target: { owner: 'content',resource: id,component: 'record',revision: id } } } }));
      const basis = await rights.exportScope(members,'quotation');
      for (const entry of basis) if (entry.result === 'prohibited') {
        for (const ordinal of entry.memberOrdinals) if (batch[ordinal - 1]) withheld.add(batch[ordinal - 1]!);
      }
    }
    return withheld;
  }
}
