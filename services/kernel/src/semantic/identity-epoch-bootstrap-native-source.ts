import type { CommandTransaction } from '../command/command.ts';
import type { NativeIdentityBirthProofWork } from './identity-epoch-bootstrap-native-birth.ts';
import nativeImages from './identity-epoch-bootstrap-native-source.sql';

type Source = Readonly<{
  route: number;
  original: string;
  terminal: string;
  source_revision: string;
  present: boolean;
}>;

/** Only a current, committed native image excludes work before bootstrap export. */
export async function currentNativeIdentitySourceImages(
  tx: CommandTransaction,
  partition: number,
  rows: readonly Source[],
  work?: NativeIdentityBirthProofWork,
): Promise<ReadonlySet<string>> {
  if (rows.length > 100) throw new RangeError('Native Source image proof page exceeds 100');
  if (!rows.length) return new Set();
  const input = JSON.stringify(rows);
  if (work) work.statements++;
  const found = await tx.query<{ original: string }>(nativeImages.sql, [partition, input]);
  if (work) {
    work.points += found.rows.length;
    work.bytes += Buffer.byteLength(input) + Buffer.byteLength(JSON.stringify(found.rows));
  }
  return new Set(found.rows.map((row) => row.original));
}
