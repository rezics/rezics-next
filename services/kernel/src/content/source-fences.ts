import type { PoolClient } from 'pg';
import type { ImportedFieldGroup } from './imported-contract.ts';

export type SourceFenceTuple = Readonly<{
  route: number;
  source: string;
  external_id: string;
  field_group: ImportedFieldGroup;
}>;

export type SourceFence = SourceFenceTuple &
  Readonly<{
    takenDown: boolean;
    securityRevision: string | null;
  }>;

/** Low-level bounded fence read for use inside a caller's independently anchored read. */
export async function readFences(
  _client: Pick<PoolClient, 'query'>,
  _tuples: readonly SourceFenceTuple[],
): Promise<readonly SourceFence[]> {
  throw new Error('readFences is not implemented');
}
