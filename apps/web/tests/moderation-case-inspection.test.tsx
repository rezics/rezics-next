import { expect, test } from 'bun:test';
import type { KernelClient } from '@rezics/client';
import {
  readModerationReportPage,
  reportReadKey,
  type ReportReadInput,
} from '../src/moderation/reports-read';
import { parseWorkbenchCaseSearch, workbenchCaseInput, workbenchCaseQueueHref } from '../src/moderation/workbench-case/read-model';

const reportId = '0192f3a0-6c1e-7b2a-9d4e-000000000101';
const postId = '0192f3a0-6c1e-7b2a-9d4e-000000000102';
const revisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000103';

const envelope = {
  report: {
    id: reportId,
    target: { kind: 'post', id: postId },
    revisionId,
    reason: 'spam',
    evidence: 'The submitted report evidence stays attached to this exact report.',
    createdAt: '2026-10-01T09:30:00.000Z',
    outcome: null,
    resolvedAt: null,
  },
  inspection: {
    reportedRevision: {
      state: 'available',
      value: { id: postId, revisionId, body: 'The exact reported revision.' },
      destination: null,
    },
    currentTarget: {
      state: 'available',
      value: { id: postId, availability: 'available', body: 'The independently read current target.' },
      destination: { boardId: 'board-current', threadId: 'thread-current', realmId: 'realm-current' },
    },
    viewer: { canDismiss: true, canTakeDown: false },
  },
};

test('a stable case request performs one exact report GET and keeps the captured cursor only for return', async () => {
  const search = parseWorkbenchCaseSearch({
    boardId: 'board-opened',
    queue: 'reports',
    status: 'pending',
    targetKind: 'post',
    order: 'oldest',
    cursor: 'signed/+case-cursor==',
    thread: 'thread-opened',
  });
  expect(search).not.toBeNull();
  const input = workbenchCaseInput(search!, reportId);
  expect(input.reportId).toBe(reportId);
  expect(workbenchCaseQueueHref(input)).toContain('cursor=signed%2B%2Fcase-cursor%3D%3D');
  expect(reportReadKey(input)).toBe(reportReadKey({ reportId, boardId: 'another-board', cursor: 'new-page' }));

  const calls: Array<{ id: string; authorization: string | undefined }> = [];
  const nativeClient = {
    reports: ({ id }: { id: string }) => ({
      get: async (headers: { authorization?: string }) => {
        calls.push({ id, authorization: headers.authorization });
        return { data: envelope, error: null };
      },
    }),
  } as unknown as KernelClient;
  const page = await readModerationReportPage(nativeClient, input, 'Bearer current-moderator', 'viewer-1');

  expect(calls).toEqual([{ id: reportId, authorization: 'Bearer current-moderator' }]);
  expect(page.state).toBe('ready');
  expect(page.reports.map(({ id }) => id)).toEqual([reportId]);
  expect(page.revisions[0]?.value).toEqual(envelope.inspection.reportedRevision.value);
  expect(page.targets[0]?.value).toEqual(envelope.inspection.currentTarget.value);
  expect(page.inspection).toEqual({
    currentState: 'available',
    reportedRevisionState: 'available',
    destination: { boardId: 'board-current', threadId: 'thread-current', realmId: 'realm-current' },
    canDismiss: true,
    canTakeDown: false,
  });
});

test('the exact report reader shares 404 for concealed and unknown IDs without scanning', async () => {
  const calls: string[] = [];
  const nativeClient = {
    reports: ({ id }: { id: string }) => ({
      get: async () => {
        calls.push(id);
        return { data: undefined, error: new Error('not found'), status: 404 };
      },
    }),
  } as unknown as KernelClient;
  const input: ReportReadInput = { reportId };
  const page = await readModerationReportPage(nativeClient, input, 'Bearer moderator', 'viewer-1');
  expect(calls).toEqual([reportId]);
  expect(page.state).toBe('unavailable');
  expect(page.reports).toEqual([]);
});

test('current concealment withholds its body and advice while preserving the distinct reported revision state', async () => {
  const nativeClient = {
    reports: () => ({
      get: async () => ({
        data: {
          ...envelope,
          inspection: {
            reportedRevision: { state: 'erased', value: null, destination: null },
            currentTarget: {
              state: 'withheld',
              value: { id: postId, body: 'PRIVATE CURRENT BODY' },
              destination: { boardId: 'concealed-board', threadId: 'concealed-thread' },
            },
            viewer: { canDismiss: false, canTakeDown: false },
          },
        },
        error: null,
      }),
    }),
  } as unknown as KernelClient;
  const page = await readModerationReportPage(nativeClient, { reportId }, 'Bearer current-moderator', 'viewer-1');

  expect(page.state).toBe('ready');
  expect(page.targets[0]?.value).toBeNull();
  expect(page.revisions[0]?.value).toBeNull();
  expect(page.inspection).toEqual({
    currentState: 'withheld',
    reportedRevisionState: 'erased',
    destination: null,
    canDismiss: false,
    canTakeDown: false,
  });
});
