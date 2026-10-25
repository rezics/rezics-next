import type { PoolClient } from 'pg';
import type { ImportedSource, Rights } from './imported-contract.ts';

export type CoverReference = Readonly<{
  id: string;
  digest: string;
  containerId: string;
  rights: Rights;
  source: ImportedSource;
}>;

/** Read an available source-backed media object reference; this does not claim the media. */
export async function checkMediaObject(
  _client: Pick<PoolClient, 'query'>,
  _id: string,
  _role: 'cover',
): Promise<CoverReference | null> {
  throw new Error('checkMediaObject is not implemented');
}
