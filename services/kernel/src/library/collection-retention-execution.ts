import { runLibraryBoundedStep } from './collection-command-work.ts';
import {
  collectionRetentionQueryBound,
  collectionRetentionControlBound,
  COLLECTION_RETENTION_CONTROLS,
  type StatementId,
} from './collection-retention-bounds.ts';

/** Bind the actual occurrence's SQL, ordered serialized operands, schema projection and result cap. */
export function executeCollectionRetentionQuery<Client, Input extends object, Result>(
  id: StatementId,
  query: Readonly<{ sql: string; params: readonly string[]; run(client: Client, input: Input): Promise<Result> }>,
  client: Client,
  input: Input,
): Promise<Result> {
  const bound = collectionRetentionQueryBound(id, query.sql, input as Readonly<Record<string, unknown>>);
  if (bound.engineRequests !== 0) throw new TypeError('Collection retention SQL cannot consume engine requests');
  return runLibraryBoundedStep(`library.collection-retention.${id}`, bound, () => query.run(client, input));
}

/** Bind BEGIN/COMMIT/ROLLBACK and fixed SET controls with their actual SQL bytes. */
export function executeCollectionRetentionControl<T>(
  operation: 'discover.begin' | 'discover.timeout' | 'discover.commit' | 'discover.rollback',
  dispatch: (sql: string) => Promise<T>,
): Promise<T> {
  const sql = COLLECTION_RETENTION_CONTROLS[operation];
  const bound = collectionRetentionControlBound(sql);
  if (bound.engineRequests !== 0) throw new TypeError('Collection retention SQL cannot consume engine requests');
  return runLibraryBoundedStep(`library.collection-retention.${operation}`, bound, () => dispatch(sql));
}
