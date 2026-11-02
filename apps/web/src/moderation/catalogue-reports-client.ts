import type { KernelClient } from '@rezics/client';

type KernelReportPost = Parameters<KernelClient['reports']['post']>[0];

export type SubjectReportPost = Omit<KernelReportPost, 'target'> & {
  target: KernelReportPost['target'] | { kind: 'subject'; id: string };
};

export type NativeModerationReport = {
  id: string;
  target: { kind: 'subject' | 'board' | 'thread' | 'post'; id: string };
  revisionId: string | null;
  reason: string;
  evidence: string | null;
  createdAt: string;
  outcome: 'actioned' | 'dismissed' | null;
  resolvedAt: string | null;
};

type NativeResult<T> = {
  data?: T;
  error?: { value: unknown };
  status: number;
};

type CatalogueReportPage = { reports: NativeModerationReport[]; next: string | null };
type SubjectReportQuery = {
  limit: number;
  order: 'newest';
  status: 'all';
  targetKind: 'subject';
};
type CatalogueReportsClient = Omit<KernelClient, 'catalogue' | 'reports' | 'subjects'> & {
  catalogue: {
    reports: {
      get(options: {
        query: { limit: number; cursor?: string };
        headers: { authorization: string };
      }): Promise<NativeResult<CatalogueReportPage>>;
    };
  };
  reports: Omit<KernelClient['reports'], 'post'> & {
    post(
      body: SubjectReportPost,
      options: Parameters<KernelClient['reports']['post']>[1],
    ): ReturnType<KernelClient['reports']['post']>;
  };
  subjects: (input: { id: string }) => ReturnType<KernelClient['subjects']> & {
    reports: {
      get(options: {
        query: SubjectReportQuery;
        headers: { authorization: string };
      }): Promise<NativeResult<CatalogueReportPage>>;
    };
  };
};

/** Native Content routes are delivered before generated Eden declarations refresh during integration. */
export function catalogueReportsClient(client: KernelClient): CatalogueReportsClient {
  return client as unknown as CatalogueReportsClient;
}
