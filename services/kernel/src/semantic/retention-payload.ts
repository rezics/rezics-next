import type { CommandTransaction } from '../command/command.ts';

/** Shared physical minimizers. Callers establish their own native lifecycle/locator authority first;
 * immutable table guards independently enforce the permitted fields. No account-T is manufactured here.
 */
export async function minimizeSemanticRecordPayload(
  tx: CommandTransaction,
  store: 'candidate' | 'revision' | 'retraction' | 'moderation',
  key: Readonly<{ low: number; high: number; recordKey: string }>,
): Promise<void> {
  const assignments = {
    candidate: "statement='{}',erasure_private=true",
    revision: 'source=NULL,verification_receipt_id=NULL,revocation_receipt_id=NULL',
    retraction: '"references"=\'[]\'',
    moderation: "body='{}',actor=NULL",
  };
  await tx.query(
    `UPDATE semantic.${store} SET ${assignments[store]}
    WHERE route BETWEEN $1 AND $2 AND erasure_key=$3`,
    [key.low, key.high, key.recordKey],
  );
}
