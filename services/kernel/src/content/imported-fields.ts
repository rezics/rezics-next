import type { CommandTransaction } from '../command/command.ts';
import type { ImportedFieldInput } from './imported-contract.ts';

export type ImportedFieldResult = Readonly<{ id: string; digest: string }>;

/** Append the source document from within the semantic command transaction. */
export async function appendImportedField(
  _tx: CommandTransaction,
  _input: ImportedFieldInput,
): Promise<ImportedFieldResult> {
  throw new Error('appendImportedField is not implemented');
}
