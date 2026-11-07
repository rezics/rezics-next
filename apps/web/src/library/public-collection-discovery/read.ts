/** Consumer result envelope. Rows remain producer-owned and are rendered by the supplied presentation. */
export type PublicCollectionDiscoveryState<Row extends { id: string } = { id: string }> =
  | { status: 'ready'; collections: Row[]; next: string | null; asOf: string }
  | {
      status:
        | 'loading'
        | 'unavailable'
        | 'not-ready'
        | 'preparing'
        | 'closed'
        | 'restart'
        | 'invalid'
        | 'unsupported'
        | 'denied'
        | 'invalid-selection';
    };
