import { basename } from 'node:path';
import { migrationRecords, type SchemaOwner } from '../ops/migrate.ts';

export { migrationVersion } from '../lib/migration-order.ts';

/** Schema tests must install the same validated, numeric inventory as a release. */
export function schemaFiles(root: string, owner: SchemaOwner): string[] {
  return migrationRecords(root, owner).map((file) => basename(file.name));
}
