import type { Report, ReportedRevision, ResolvedReportTarget } from '../../../moderation/reports-read';

export const postReport: Report = {
  id: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
  target: { kind: 'post', id: '0192f3a0-6c1e-7b2a-9d4e-000000000050' },
  revisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000052',
  reason: 'other',
  evidence: 'The original post disclosed a private address.',
  createdAt: '2026-10-28T15:30:00.000Z',
  outcome: null,
  resolvedAt: null,
};
const threadReport: Report = {
  ...postReport,
  id: '0192f3a0-6c1e-7b2a-9d4e-000000000002',
  target: { kind: 'thread', id: '0192f3a0-6c1e-7b2a-9d4e-000000000051' },
  revisionId: null,
  reason: 'spam',
  evidence: null,
};
export const currentText = 'Edited current text with the address removed.';
export const revisionText = 'Original reported text.';
export const reason = 'Private address disclosure.';

// Contract-shaped presenter inputs, shared with the canonical pages; no reporter identities or moderator notes.
export const moderationQueueFixture = {
  reports: [postReport, threadReport],
  targets: [
    {
      key: `post:${postReport.target.id}`,
      kind: 'post',
      value: {
        post: {
          body: {
            version: 'rezics-document-v1',
            profile: 'blocks',
            doc: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  attrs: { id: 'moderation-report-post' },
                  content: [{ type: 'text', text: currentText }],
                },
              ],
            },
          },
        },
      },
    },
    {
      key: `thread:${threadReport.target.id}`,
      kind: 'thread',
      value: { thread: { title: 'A reported advertising thread' } },
    },
  ] satisfies ResolvedReportTarget[],
  revisions: [{ reportId: postReport.id, value: { post: { body: revisionText } } }] satisfies ReportedRevision[],
};
export const selectedQueueFixture = {
  ...moderationQueueFixture,
  reports: [postReport],
  selection: { status: 'pending', targetKind: 'post', order: 'oldest' } as const,
};

export const resolvedQueueFixture = {
  ...moderationQueueFixture,
  reports: [
    { ...postReport, outcome: 'actioned', resolvedAt: '2026-10-29T08:30:00.000Z' },
    { ...threadReport, outcome: 'dismissed', resolvedAt: '2026-10-29T08:45:00.000Z' },
  ] satisfies Report[],
};

export const queueViewports = {
  phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
  desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
};
