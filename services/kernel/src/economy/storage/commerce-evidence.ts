import type { EconomyResult } from '../contract.ts';
import type { EconomyDatabase } from '../ledger.ts';

type CommerceEvidence = Readonly<{
  orderId: string;
  creatorId: string;
  offerId: string;
  statementId: string;
  movementId: string;
  sourceId: string;
  kind: string;
  currency: string;
  unit: Readonly<{ system: string; exponent: number; factsVersion: string }>;
  amountMinor: string;
  feeMinor: string;
  netMinor: string;
  economicDigest: string;
}>;

type EvidenceReceipt = Readonly<{ namespace: string; mode: 'test'; movementId: string }>;

/** Separate evidence registration. No native posting or provider movement consumption is performed here. */
export function registerCommerceEvidence(
  database: EconomyDatabase,
  bookId: string,
  namespace: string,
  evidence: CommerceEvidence,
): Promise<EconomyResult<EvidenceReceipt>> {
  const receipt = { namespace, mode: 'test', movementId: evidence.movementId } satisfies EvidenceReceipt;
  return database.transaction(async (client) => {
    const book = await client.query('SELECT 1 FROM economy.asset WHERE book_id = $1 LIMIT 1', [bookId]);
    if (!book.rowCount) return { kind: 'asset_missing' };
    const args = [
      namespace,
      receipt.mode,
      evidence.movementId,
      bookId,
      evidence.orderId,
      evidence.creatorId,
      evidence.offerId,
      evidence.statementId,
      evidence.sourceId,
      evidence.kind,
      evidence.currency,
      JSON.stringify(evidence.unit),
      evidence.amountMinor,
      evidence.feeMinor,
      evidence.netMinor,
      evidence.economicDigest,
    ];
    const inserted = await client.query(
      `INSERT INTO economy.commerce_evidence_receipt
         (provider_namespace, provider_mode, movement_id, book_id, order_id, creator_id, offer_id, statement_id,
          source_id, movement_kind, currency, unit, amount_minor, fee_minor, net_minor, economic_digest)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16)
       ON CONFLICT (provider_namespace, provider_mode, movement_id) DO NOTHING
       RETURNING 1`,
      args,
    );
    if (inserted.rowCount) return { kind: 'ok', value: receipt };
    // A concurrent insertion has already committed before the conflict check returns.
    const retained = await client.query(
      `SELECT 1 FROM economy.commerce_evidence_receipt
       WHERE provider_namespace = $1 AND provider_mode = $2 AND movement_id = $3
         AND (book_id, order_id, creator_id, offer_id, statement_id, source_id, movement_kind, currency, unit,
              amount_minor, fee_minor, net_minor, economic_digest)
           = ($4::text, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9::text, $10::text, $11::text, $12::jsonb,
              $13::bigint, $14::bigint, $15::bigint, $16::text)`,
      args,
    );
    return retained.rowCount ? { kind: 'ok', value: receipt } : { kind: 'operation_conflict' };
  });
}
