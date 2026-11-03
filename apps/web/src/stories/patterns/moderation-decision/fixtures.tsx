import type { DecisionPage } from '../../../moderation/decision-read';

export const decisionNow = Date.parse('2026-10-31T12:00:00.000Z');
// Response shapes follow Content's populated, concealed and unavailable examples; they are not native evidence.
export const openDecision: DecisionPage = {
  viewerId: '0192f3a0-6c1e-7b2a-9d4e-000000000090',
  nativeSourceFingerprint: 'illustrative-source-open',
  decision: {
    id: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
    targetKind: 'post',
    targetId: '0192f3a0-6c1e-7b2a-9d4e-000000000050',
    action: 'takedown',
    statement:
      'This post shared another person’s private contact details without their consent. Personal contact information must be removed before it can be shared in this community.',
    decidedAt: '2026-10-01T09:30:00.000Z',
    appealDeadline: '2027-04-02T09:30:00.000Z',
    appeal: null,
    viewer: {
      affectedAuthor: true,
      observedAt: '2026-10-31T12:00:00.000Z',
      appeal: { state: 'permitted' },
    },
    targetContext: { state: 'concealed' },
  },
};
export const pendingDecision: DecisionPage = {
  ...openDecision,
  nativeSourceFingerprint: 'illustrative-source-pending',
  decision: {
    ...openDecision.decision,
    appeal: { id: '0192f3a0-6c1e-7b2a-9d4e-000000000080', outcome: null, statement: null, resolvedAt: null },
    viewer: { ...openDecision.decision.viewer, appeal: { state: 'unavailable', reason: 'already_appealed' } },
  },
};
export function resolvedDecision(outcome: 'reversed' | 'upheld'): DecisionPage {
  return {
    ...pendingDecision,
    nativeSourceFingerprint: `illustrative-source-${outcome}`,
    decision: {
      ...pendingDecision.decision,
      appeal: {
        ...pendingDecision.decision.appeal!,
        outcome,
        statement:
          outcome === 'reversed'
            ? 'An independent review found that the contact details were published by the organization for public event enquiries. The takedown was reversed.'
            : 'An independent review confirmed that the contact details identify a private individual. The takedown remains in place.',
        resolvedAt: '2026-10-30T10:15:00.000Z',
      },
    },
  };
}
export const availableDecision: DecisionPage = {
  ...resolvedDecision('reversed'),
  decision: {
    ...resolvedDecision('reversed').decision,
    targetContext: {
      state: 'available',
      kind: 'thread',
      threadId: '0192f3a0-6c1e-7b2a-9d4e-000000000040',
      postId: '0192f3a0-6c1e-7b2a-9d4e-000000000050',
      boardId: '0192f3a0-6c1e-7b2a-9d4e-000000000030',
      threadTitle: 'Current context after reversal',
      boardTitle: 'Current board',
    },
  },
};
export const expiredDecision: DecisionPage = {
  ...openDecision,
  nativeSourceFingerprint: 'illustrative-source-expired',
  decision: {
    ...openDecision.decision,
    decidedAt: '2026-04-01T09:30:00.000Z',
    appealDeadline: '2026-10-01T09:30:00.000Z',
    viewer: { ...openDecision.decision.viewer, appeal: { state: 'unavailable', reason: 'deadline_passed' } },
  },
};
export const unavailableContextDecision: DecisionPage = {
  ...openDecision,
  nativeSourceFingerprint: 'illustrative-source-unavailable-context',
  decision: { ...openDecision.decision, targetContext: { state: 'unavailable' } },
};
export const unavailableAdviceDecision: DecisionPage = {
  ...openDecision,
  nativeSourceFingerprint: 'illustrative-source-unavailable-advice',
  decision: {
    ...openDecision.decision,
    viewer: { ...openDecision.decision.viewer, appeal: { state: 'unavailable', reason: 'command_unavailable' } },
  },
};
export const unsupportedBoardDecision: DecisionPage = {
  ...openDecision,
  nativeSourceFingerprint: 'illustrative-source-board',
  decision: {
    ...openDecision.decision,
    targetKind: 'board',
    targetId: '0192f3a0-6c1e-7b2a-9d4e-000000000030',
    appealDeadline: null,
    viewer: { ...openDecision.decision.viewer, appeal: { state: 'unsupported', reason: 'board' } },
    targetContext: {
      state: 'available',
      kind: 'board',
      boardId: '0192f3a0-6c1e-7b2a-9d4e-000000000030',
      boardTitle: 'Current board',
    },
  },
};
export const appealDraft = 'These are the organization’s public event contact details. Please review their context.';
