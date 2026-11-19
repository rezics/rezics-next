import type { CommandTransaction } from '../command/command.ts';
import nativeBirths from './identity-epoch-bootstrap-native-birth.sql';

type Source = Readonly<{ route: number; original: string; source_revision: string; present: boolean }>;
export type NativeIdentityBirthProofWork = { statements: number; points: number; bytes: number };

/** Admission checks structural identity. Bootstrap and source ACK also require the untouched birth row. */
export async function currentNativeIdentityBirths(
  tx: CommandTransaction,
  partition: number,
  rows: readonly Source[],
  purpose: 'bootstrap' | 'admission',
  work?: NativeIdentityBirthProofWork,
): Promise<ReadonlySet<string>> {
  if (rows.length > 100) throw new RangeError('Native birth proof page exceeds 100');
  if (!rows.length) return new Set();
  const input = JSON.stringify(rows);
  if (work) work.statements++;
  const found = await tx.query<{ original: string }>(nativeBirths.sql, [partition, input, purpose === 'admission']);
  if (work) {
    work.points += found.rows.length;
    work.bytes += Buffer.byteLength(input) + Buffer.byteLength(JSON.stringify(found.rows));
  }
  return new Set(found.rows.map((row) => row.original));
}
