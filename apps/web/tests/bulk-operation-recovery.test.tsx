import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  appendBulkOutcomePage,
  bulkRecoveryStatus,
  canCancelBulkOperation,
  type LibraryBulkOutcome,
  type LibraryBulkRecoveryRead,
} from '../src/library/bulk-operation-recovery';
import {
  readBulkOperationFromNative,
  readBulkOperationPageFromNative,
  sendCapturedBulkCancelCommand,
  type CapturedCancelCommand,
} from '../src/library/bulk-operation-recovery-native';
import { LibraryBulkOperationRecoveryView } from '../src/library/bulk-operation-recovery-view';

const operationId = '01b5b3de-6ad2-7fc8-a604-e058df922001';
const subjectId = '01b5b3de-6ad2-7fc8-a604-e058df922002';

function operation(phase: 'completed' | 'applying' | 'preview' = 'completed') {
  return {
    id: operationId,
    route: 1,
    action: 'remove_from_library' as const,
    selectionKind: 'explicit' as const,
    state: null,
    collectionId: null,
    phase,
    selectionComplete: true,
    occurrencesComplete: true,
    cancelRequested: false,
    counts: {
      scannedCandidates: 1,
      selectedSubjects: 1,
      scannedOccurrences: 0,
      capturedOccurrences: 0,
      targets: 1,
      pending: 0,
      reconciling: 0,
      applied: phase === 'completed' ? 1 : 0,
      no_effect: 0,
      conflict: 0,
      denied: 0,
      failed: 0,
      cancelled: 0,
    },
    summary: null,
    admittedAt: '2026-11-03T01:00:00.000Z',
    targetBoundAt: null,
    expiresAt: '2026-11-04T01:00:00.000Z',
    resultsExpireAt: '2026-11-05T01:00:00.000Z',
    finishedAt: null,
    reason: null,
  };
}

function outcome(state: LibraryBulkOutcome['state'], ordinal = '0'): LibraryBulkOutcome {
  return { ordinal, subjectId, memberId: null, state, reason: null, resultingMemberId: null };
}

test('renders the captured operation and results without issuing a command', () => {
  const calls: string[] = [];
  const read: LibraryBulkRecoveryRead = {
    state: 'available',
    operation: operation(),
    outcomes: [outcome('applied')],
    next: null,
  };
  const html = renderToStaticMarkup(
    createElement(LibraryBulkOperationRecoveryView, {
      addressOperationId: operationId,
      authorized: true,
      read,
      readAgain: (id) => calls.push(`read:${id}`),
      readMore: (id, cursor) => calls.push(`more:${id}:${cursor}`),
    }),
  );

  expect(html).toContain('Remove from Library');
  expect(html).toContain('Completed');
  expect(html).toContain(subjectId);
  expect(html).toContain('2026-11-04T01:00:00.000Z');
  expect(calls).toEqual([]);
});

test('keeps empty completion distinct from forbidden, expired and unavailable reads', () => {
  const empty = renderToStaticMarkup(
    createElement(LibraryBulkOperationRecoveryView, {
      addressOperationId: operationId,
      authorized: true,
      read: { state: 'available', operation: operation(), outcomes: [], next: null },
      readAgain: () => {},
      readMore: () => {},
    }),
  );
  const labels = (['expired', 'forbidden', 'unavailable'] as const).map((state) =>
    renderToStaticMarkup(
      createElement(LibraryBulkOperationRecoveryView, {
        addressOperationId: operationId,
        authorized: true,
        read: { state, operationId },
        readAgain: () => {},
        readMore: () => {},
      }),
    ),
  );

  expect(empty).toContain('Completed');
  expect(empty).toContain('No target results are recorded.');
  expect(new Set(labels).size).toBe(3);
  expect(labels.every((label) => label !== empty)).toBe(true);
});

test('keeps native cursor paging on the same operation and rejects obsolete or unauthorized pages', () => {
  const current: LibraryBulkRecoveryRead = {
    state: 'available',
    operation: operation('applying'),
    outcomes: [outcome('pending')],
    next: 'native-cursor',
  };
  const page = { outcomes: [outcome('applied', '1')], next: null };
  const accepted = appendBulkOutcomePage({
    addressOperationId: operationId,
    authorized: true,
    requestedOperationId: operationId,
    requestedCursor: 'native-cursor',
    current,
    page,
  });

  expect(bulkRecoveryStatus(current.outcomes[0]!)).toBe('unattempted');
  expect(bulkRecoveryStatus(accepted.state === 'available' ? accepted.outcomes[1]! : outcome('pending'))).toBe(
    'success',
  );
  expect(accepted.state === 'available' && accepted.next).toBeNull();
  expect(
    appendBulkOutcomePage({
      addressOperationId: '01b5b3de-6ad2-7fc8-a604-e058df922099',
      authorized: true,
      requestedOperationId: operationId,
      requestedCursor: 'native-cursor',
      current,
      page,
    }),
  ).toBe(current);
  expect(
    appendBulkOutcomePage({
      addressOperationId: operationId,
      authorized: false,
      requestedOperationId: operationId,
      requestedCursor: 'native-cursor',
      current,
      page,
    }),
  ).toBe(current);
});

test('reads only bounded native operation results and keeps later pages on their native cursor', async () => {
  const requests: Array<{ method: string; path: string; query: URLSearchParams; authorization: string | null }> = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        authorization: request.headers.get('authorization'),
      });
      return url.pathname.endsWith('/outcomes')
        ? Response.json({ outcomes: [outcome('pending')], next: 'native-cursor' })
        : Response.json({ operation: operation('applying') });
    },
  });

  const first = await readBulkOperationFromNative(client, operationId, 'Bearer viewer');
  const later = await readBulkOperationPageFromNative(client, operationId, 'native-cursor', 'Bearer viewer');

  expect(first.state).toBe('available');
  expect(later.state).toBe('available');
  expect(requests.map(({ method, path }) => [method, path])).toEqual([
    ['GET', `/v1/libraryOperations/${operationId}`],
    ['GET', `/v1/libraryOperations/${operationId}/outcomes`],
    ['GET', `/v1/libraryOperations/${operationId}/outcomes`],
  ]);
  expect(requests.every((request) => request.method === 'GET' && request.authorization === 'Bearer viewer')).toBe(true);
  expect(requests[1]?.query.get('limit')).toBe('20');
  expect(requests[2]?.query.get('limit')).toBe('20');
  expect(requests[2]?.query.get('cursor')).toBe('native-cursor');
});

test('keeps missing results, missing operations and native denial distinct', async () => {
  async function readWith(operationStatus: number, outcomesStatus: number) {
    const client = createKernelClient('https://kernel.test', {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const status = new URL(request.url).pathname.endsWith('/outcomes') ? outcomesStatus : operationStatus;
        return status === 200
          ? Response.json(
              new URL(request.url).pathname.endsWith('/outcomes')
                ? { outcomes: [], next: null }
                : { operation: operation() },
            )
          : Response.json({ status, code: status === 403 ? 'forbidden' : 'not_found' }, { status });
      },
    });
    return readBulkOperationFromNative(client, operationId, 'Bearer viewer');
  }

  expect(await readWith(404, 200)).toMatchObject({ state: 'unavailable', operationId });
  expect(await readWith(200, 404)).toMatchObject({ state: 'expired', operationId });
  expect(await readWith(403, 200)).toMatchObject({ state: 'forbidden', operationId });
});

test('retries an uncertain cancellation with the same captured native command identity', async () => {
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ operation: operation('applying') });
    },
  });
  const command: CapturedCancelCommand = {
    version: 1,
    operationId,
    sender: 'viewer-1',
    method: 'POST',
    path: `/v1/libraryOperations/${operationId}:cancel`,
    locale: 'en',
    headers: {
      authorization: 'Bearer viewer',
      'idempotency-key': 'cancel-command-identity',
      'accept-language': 'en',
      'content-type': 'application/json',
    },
    body: {},
  };

  await sendCapturedBulkCancelCommand(client, command);
  await sendCapturedBulkCancelCommand(client, command);

  expect(requests).toHaveLength(2);
  expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
    ['POST', `/v1/libraryOperations/${operationId}:cancel`],
    ['POST', `/v1/libraryOperations/${operationId}:cancel`],
  ]);
  expect(requests.map((request) => request.headers.get('idempotency-key'))).toEqual([
    'cancel-command-identity',
    'cancel-command-identity',
  ]);
  expect(requests.every((request) => request.headers.get('authorization') === 'Bearer viewer')).toBe(true);
  expect(requests.every((request) => request.headers.get('accept-language') === 'en')).toBe(true);
  expect(requests.every((request) => request.headers.get('content-type') === 'application/json')).toBe(true);
  expect(await Promise.all(requests.map((request) => request.clone().text()))).toEqual(['{}', '{}']);
});

test('offers cancellation only for an active native operation phase and current cancellation state', () => {
  expect(canCancelBulkOperation(operation('preview'))).toBe(true);
  expect(canCancelBulkOperation(operation('applying'))).toBe(true);
  expect(canCancelBulkOperation(operation())).toBe(false);
  expect(canCancelBulkOperation({ ...operation('applying'), cancelRequested: true })).toBe(false);
});
