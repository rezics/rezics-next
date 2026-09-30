import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { WikiEvidence, WikiExtraction } from './protocol.ts';
import { WikiRejected } from './errors.ts';

export const WIKI_QUOTATION_POLICY = { version: 1, passageCodePoints: 200, workCodePoints: 10000 } as const;
export const WIKI_QUOTATION_COST = { sqlStatements: 4, statementMs: 1000, appliedRows: 10001,
  submittedKeys: 28672 } as const;
export interface QuotationUse { representationSha256: string; locatorDigest: string;
  quoteDigest: string; codePoints: number }
export interface QuotationReader {
  read(work: string, uses: readonly QuotationUse[]): Promise<{ appliedCodePoints: number; existing: ReadonlySet<string> }>;
}
export const quotationKey = (use: QuotationUse) => `${use.representationSha256}:${use.locatorDigest}:${use.quoteDigest}`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
/** Object-key order does not change a quotation's identity. Quotation bytes,
 * offsets, route guards and CFI assertions are never normalized. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function evidenceQuotationUses(evidence: WikiEvidence): QuotationUse[] {
  const source = evidence.locator.source;
  if (source.type !== 'external') throw new WikiRejected('wiki_locator_source');
  const locatorDigest = digest(canonical({ version: evidence.locator.version, source,
    selector: evidence.locator.selector }));
  const quotes = [evidence.quote];
  const add = (selector: { exact: string; prefix?: string; suffix?: string }) => {
    if (selector.exact !== evidence.quote) throw new WikiRejected('wiki_quote_mismatch');
    quotes.push(selector.exact, selector.prefix ?? '', selector.suffix ?? '');
  };
  if (evidence.locator.selector.type === 'TextQuoteSelector') add(evidence.locator.selector);
  if (evidence.locator.quote) add(evidence.locator.quote);
  const uses = [...new Set(quotes.filter(Boolean))].map(quote => {
    const codePoints = [...quote].length;
    if (codePoints > WIKI_QUOTATION_POLICY.passageCodePoints) throw new WikiRejected('wiki_passage_limit');
    return { representationSha256: source.representationSha256, locatorDigest,
      quoteDigest: digest(quote), codePoints };
  });
  // Locator fallbacks also transmit source text. They share the same passage
  // allowance; extra prefix/suffix fields cannot widen it.
  if (uses.reduce((total, use) => total + use.codePoints, 0) > WIKI_QUOTATION_POLICY.passageCodePoints) {
    throw new WikiRejected('wiki_passage_limit');
  }
  return uses;
}
export function extractionQuotationUses(bundle: WikiExtraction): QuotationUse[] {
  const uses = bundle.claims.flatMap(claim => claim.evidence.flatMap(evidenceQuotationUses));
  return [...new Map(uses.map(use => [quotationKey(use), use])).values()];
}
/** One indexed Work aggregate and an exact-key membership read; no account,
 * language, realization, Zone or pending-proposal filter can reset the budget.
 * G-846's apply writes under its own transaction and rechecks this policy. */
export class WikiQuotationStore implements QuotationReader {
  constructor(readonly pool: Pool) {}
  async read(work: string, uses: readonly QuotationUse[]) {
    if (uses.length > WIKI_QUOTATION_COST.submittedKeys) throw new WikiRejected('wiki_query_budget');
    const keys = uses.map(quotationKey);
    const client = await this.pool.connect().catch(() => { throw new WikiRejected('wiki_quotation_unavailable', 503); });
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = '${WIKI_QUOTATION_COST.statementMs}ms'`);
      const result = await client.query<{ applied: string; existing: string[] | null }>(`
        SELECT coalesce(sum(code_points), 0)::text AS applied,
          array_agg(representation_sha256 || ':' || locator_digest || ':' || quote_digest)
            FILTER (WHERE representation_sha256 || ':' || locator_digest || ':' || quote_digest = ANY($2::text[])) AS existing
        FROM (SELECT representation_sha256, locator_digest, quote_digest, code_points
          FROM wiki.quotation WHERE work = $1 LIMIT ${WIKI_QUOTATION_COST.appliedRows}) applied_quotes`, [work, keys]);
      const row = result.rows[0];
      if (!row || !/^\d+$/.test(row.applied) || !Number.isSafeInteger(Number(row.applied))) {
        throw new WikiRejected('wiki_quotation_unavailable', 503);
      }
      // Every row counts at least one point. A 10,001-row prefix necessarily
      // exceeds v1, so truncation can only reject, never certify a preview.
      await client.query('COMMIT');
      return { appliedCodePoints: Number(row.applied), existing: new Set(row.existing ?? []) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof WikiRejected) throw error;
      throw new WikiRejected('wiki_quotation_unavailable', 503);
    } finally { client.release(); }
  }
}
export async function quotationPreview(reader: QuotationReader, work: string, uses: readonly QuotationUse[]) {
  const applied = await reader.read(work, uses);
  const addedCodePoints = uses.reduce((total, use) => total + (applied.existing.has(quotationKey(use)) ? 0 : use.codePoints), 0);
  if (applied.appliedCodePoints + addedCodePoints > WIKI_QUOTATION_POLICY.workCodePoints) {
    throw new WikiRejected('wiki_work_quotation_budget');
  }
  return { policy: WIKI_QUOTATION_POLICY, appliedCodePoints: applied.appliedCodePoints, addedCodePoints,
    projectedCodePoints: applied.appliedCodePoints + addedCodePoints, uses };
}
