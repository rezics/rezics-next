import type { PublicCollectionDirectoryAddress } from '../../search/contracts/collection-directory';
import type { PublicCollectionDiscoveryState } from './read';

export const publicCollectionKind = 'collection';
export const publicCollectionPageSize = 24;

/** Exactly one anonymous directory window; the producer owns native request construction and admission. */
export type PublicCollectionDiscoveryReader<Row extends { id: string } = { id: string }> = (input: {
  data: { locale: string } & PublicCollectionDirectoryAddress;
  signal?: AbortSignal;
}) => Promise<PublicCollectionDiscoveryState<Row>>;
