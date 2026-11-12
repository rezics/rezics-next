import type { HostedRevisionView } from './hosted-chapters-model.ts';

export type HostedHistoryInput = Readonly<{
  limit?: number;
  cursor?: string;
}>;

/** Only immutable selection metadata belongs here. Targets, titles, bodies,
 * command receipts and transaction identities stay in their existing readers. */
export type HostedHistoryItem = HostedRevisionView &
  Readonly<{
    createdAt: string;
    isCurrentDraft: boolean;
    isCurrentRelease: boolean;
  }>;

export type HostedHistoryPage = Readonly<{
  catalogueId: string;
  items: readonly HostedHistoryItem[];
  nextCursor: string | null;
}>;

export type HostedHistoryRow = Readonly<{
  revision_id: string;
  kind: 'structure' | 'publication';
  source_revision_id: string | null;
  created_at: string;
}>;

/** PostgreSQL microseconds are preserved as text, never rounded through Date. */
export type HostedHistoryKey = Readonly<{
  createdAt: string;
  revisionId: string;
}>;

export type HostedHistoryCursor = Readonly<{
  after: HostedHistoryKey;
  epoch: number;
  issuedAt: number;
}>;
