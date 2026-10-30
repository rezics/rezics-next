import type { ReporterStatus } from '../../moderation/reporter-status-model';

export const submittedReport: ReporterStatus = {
  id: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
  target: { kind: 'post', id: '0192f3a0-6c1e-7b2a-9d4e-000000000002' },
  revisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000003',
  reason: 'spam',
  evidence: 'Repeated advertising appeared in this discussion. I submitted this report from the post menu.',
  reporterId: '0192f3a0-6c1e-7b2a-9d4e-000000000004',
  createdAt: '2026-10-30T10:00:00.000Z',
  resolvedAt: null,
  outcome: null,
  targetAvailability: 'available',
};

export const reporterStatusViewports = {
  phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
  desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
};
