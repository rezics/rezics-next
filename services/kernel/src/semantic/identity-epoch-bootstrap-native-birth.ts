import type { CommandTransaction } from '../command/command.ts';
import nativeBirths from './identity-epoch-bootstrap-native-birth.sql';

type Source = Readonly<{ route: number; original: string; source_revision: string; present: boolean }>;
export type NativeIdentityBirthProofWork = { statements: number; points: number; bytes: number };

/** Reuse installation's exact birth custody; an updated or unproved source stays bootstrap work. */
export async function currentNativeIdentityBirths(
  tx: CommandTransaction,
  partition: number,
  rows: readonly Source[],
  work?: NativeIdentityBirthProofWork,
): Promise<ReadonlySet<string>> {
  if (rows.length > 100) throw new RangeError('Native birth proof page exceeds 100');
  if (!rows.length) return new Set();
  const input = JSON.stringify(rows);
  if (work) work.statements++;
  const found = await tx.query<{ original: string }>(nativeBirths.sql, [partition, input]);
  if (work) {
    work.points += found.rows.length;
    work.bytes += Buffer.byteLength(input) + Buffer.byteLength(JSON.stringify(found.rows));
  }
  return new Set(found.rows.map((row) => row.original));
}
