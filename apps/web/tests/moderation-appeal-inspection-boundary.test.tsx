import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAppealResolutionIntent } from '../src/moderation/appeal-resolution/intent';
import { appealReadKey, moderationAppealInput } from '../src/moderation/appeals-read-model';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/threads/authoring-departure', () => ({
  AuthoringDepartureBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
  useAuthoringDeparture: () => ({ release() {} }),
}));
const { WorkbenchAppeal } = await import('../src/moderation/workbench-appeal');
const { readModerationAppealPage, admitAppealInspection } = await import('../src/moderation/appeals-read');
const { privateReaderFingerprint } = await import('../src/moderation/private-reader-origin');
const session = { state: 'signed-in', subject: 'viewer', csrfToken: 'csrf' };
const origin = { subject: session.subject, csrfFingerprint: await privateReaderFingerprint(session.csrfToken) };
const source = { partition: 0, epoch: 1, position: '12' };
const provenance = { actorId: 'viewer', session: { clientId: 'web', authnEpoch: 1 }, source };
const authorization = `Bearer ${btoa('{}')}.${btoa(JSON.stringify({ sub: 'viewer', client_id: 'web', authn_epoch: 1 }))}.signature`;

const row = {
  id: 'appeal',
  decisionId: 'decision',
  appellantId: 'private-account',
  statement: 'Restore this.',
  createdAt: '2026-11-01T00:00:00Z',
  canResolve: false,
  decision: { statement: 'Original decision.', target: { kind: 'board' as const, id: 'board' } },
};

test('1/10/20 installed rows cross the adapter and panel without identity or target reads; sparse stays sparse', async () => {
  for (const count of [1, 10, 20, 0]) {
    const calls: string[] = [];
    const client = createKernelClient('https://kernel.test', {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        calls.push(new URL(request.url).pathname);
        expect(request.cache).toBe('no-store');
        return Response.json({
          appeals: Array.from({ length: count }, (_, i) => ({ ...row, id: `appeal-${i}` })),
          next: 'opaque',
        });
      },
    });
    const page = await readModerationAppealPage(client, { boardId: 'board' }, 'Bearer viewer', 'viewer');
    expect(page.state).toBe('ready');
    expect(page.appeals).toHaveLength(count);
    expect(page.targets).toEqual([]);
    expect(page.next).toBe('opaque');
    expect(calls).toEqual(['/v1/boards/board/appeals']);
    const markup = renderToStaticMarkup(
      createElement(WorkbenchAppeal, {
        appealId: row.id,
        page: { state: 'ready', appeals: page.appeals, selectedAppeal: row },
        queueHref: '?cursor=captured',
      }),
    );
    expect(markup).toContain('Original decision.');
    expect(markup).toContain('Restore this.');
    expect(markup).toContain('href="?cursor=captured"');
    expect(markup).not.toContain('private-account');
    const resolved = renderToStaticMarkup(
      createElement(WorkbenchAppeal, {
        appealId: row.id,
        page: {
          state: 'ready',
          appeals: [],
          selectedAppeal: {
            ...row,
            decision: {
              ...row.decision,
              appeal: { outcome: 'reversed', statement: 'Restored.', resolvedAt: row.createdAt },
            },
          },
        },
        queueHref: '?cursor=captured',
      }),
    );
    expect(resolved).toContain(m.moderation_appeal_reversed());
    expect(resolved).toContain('Restored.');
  }
});

test('inspect binds the private read identity and uncertain delivery keeps its original sender and command', async () => {
  const input = moderationAppealInput('board', { cursor: 'captured', inspect: 'appeal' });
  expect(input.inspect).toBe('appeal');
  expect(appealReadKey(input)).not.toBe(appealReadKey({ ...input, inspect: 'other' }));
  const intent = createAppealResolutionIntent('appeal', 'original-native-session');
  intent.synchronize('appeal', 'viewer-session', true);
  intent.edit('Review.');
  const calls: unknown[] = [];
  const command = intent.begin('reverse', async (original) => {
    calls.push(original);
    throw new Error('lost');
  })!;
  await expect(intent.send(command)).rejects.toThrow('lost');
  intent.uncertain();
  expect(intent.retry()).toBe(command);
  expect(command.nativeSession).toBe('original-native-session');
  await expect(intent.send(command)).rejects.toThrow('lost');
  expect(calls.length).toBe(2);
  expect(calls.every((item) => item === command)).toBe(true);
  intent.synchronize('appeal', 'replacement-session', true);
  await expect(intent.send(command)).rejects.toThrow('unavailable');
});

test('composed inspection seam admits only current actor/session, exact outcome, token and covered source', () => {
  const selected = {
    ...row,
    source,
    resolution: null,
    resolutionCommand: {
      operationId: 'moderation_appeal.resolve' as const,
      method: 'POST' as const,
      path: '/v1/moderation-appeals/appeal:resolve',
    },
  };
  const page = { appeals: [], next: 'sparse-next', selectedAppeal: selected, provenance };
  expect(admitAppealInspection(page, row.id, authorization, 'viewer', origin, 'opaque-native-session')).toMatchObject({
    nativeSession: 'opaque-native-session',
    selectedAppeal: { id: row.id, resolution: null },
    next: 'sparse-next',
  });
  const resolved = {
    ...selected,
    resolution: { outcome: 'upheld' as const, statement: 'Reviewed.', resolvedAt: row.createdAt },
  };
  expect(
    admitAppealInspection(
      { ...page, selectedAppeal: resolved },
      row.id,
      authorization,
      'viewer',
      origin,
      'opaque-native-session',
    ).selectedAppeal,
  ).toBe(resolved);
  for (const invalid of [
    { ...page, appeals: Array.from({ length: 21 }, () => selected) },
    { ...page, appeals: [{ ...selected, source: { ...source, partition: 1 } }] },
    { ...page, selectedAppeal: { ...selected, source: { ...source, partition: 1 } } },
    { ...page, provenance: { ...provenance, actorId: 'other' } },
    { ...page, provenance: { ...provenance, session: { clientId: 'other', authnEpoch: 1 } } },
    { ...page, provenance: { ...provenance, session: { clientId: 'web', authnEpoch: 2 } } },
    { ...page, selectedAppeal: { ...selected, id: 'other' } },
    { ...page, selectedAppeal: { ...selected, source: { ...source, position: '13' } } },
    { ...page, selectedAppeal: { ...row, source, resolutionCommand: selected.resolutionCommand } },
  ])
    expect(() =>
      admitAppealInspection(invalid, row.id, authorization, 'viewer', origin, 'opaque-native-session'),
    ).toThrow();
  expect(() => admitAppealInspection(page, row.id, authorization, 'viewer', origin, null)).toThrow();
});

test('native same-intent retry echoes original opaque session and operands; advice cannot override native denial', async () => {
  const { sendModerationAppealResolution } = await import('../src/moderation/actions');
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return requests.length === 1
        ? Response.json({ code: 'dependency_unavailable' }, { status: 503 })
        : Response.json({ id: 'appeal' });
    },
  });
  const intent = createAppealResolutionIntent('appeal', 'opaque-original');
  intent.synchronize('appeal', 'browser-session', true);
  intent.edit('  Review.  ');
  const command = intent.begin('reverse', (original) =>
    sendModerationAppealResolution(client, original, 'Bearer original'),
  )!;
  await expect(intent.send(command)).rejects.toThrow();
  intent.uncertain();
  expect(intent.retry()).toBe(command);
  intent.settle(await intent.send(command));
  expect(intent.result).toEqual({ state: 'resolved', outcome: 'reverse', statement: 'Review.' });
  for (const request of requests) {
    expect(new URL(request.url).pathname).toBe('/v1/moderation-appeals/appeal:resolve');
    expect(request.headers.get('rezics-session-token')).toBe('opaque-original');
    expect(request.headers.get('authorization')).toBe('Bearer original');
    expect(request.headers.get('idempotency-key')).toBe(JSON.stringify(command.idempotencyKey));
    expect(await request.json()).toEqual({ outcome: 'reverse', statement: 'Review.' });
  }
  const denied = createKernelClient('https://kernel.test', {
    fetch: async () => Response.json({ code: 'forbidden' }, { status: 403 }),
  });
  expect(await sendModerationAppealResolution(denied, command, 'Bearer original')).toEqual({ state: 'forbidden' });
});

test('installed board/thread inspection makes one captured request and admits only its exact native selection', async () => {
  for (const threadId of [undefined, 'thread'])
    for (const resolved of [false, true]) {
      const selected = {
        ...row,
        source,
        resolution: resolved ? { outcome: 'upheld', statement: 'Reviewed.', resolvedAt: row.createdAt } : null,
        resolutionCommand: {
          operationId: 'moderation_appeal.resolve',
          method: 'POST',
          path: '/v1/moderation-appeals/appeal:resolve',
        },
      };
      const wire = { appeals: [], next: 'sparse', selectedAppeal: selected, provenance };
      let body: unknown = wire;
      let token = 'opaque-original';
      const requests: Request[] = [];
      const client = createKernelClient('https://kernel.test', {
        fetch: async (input, init) => {
          requests.push(new Request(input, init));
          return Response.json(body, { headers: { 'rezics-session-token': token } });
        },
      });
      const input = { boardId: 'board', threadId, cursor: 'captured', inspect: row.id };
      const read = () => readModerationAppealPage(client, input, authorization, 'viewer', origin);
      expect(await read()).toMatchObject({
        state: 'ready',
        selectedAppeal: { id: row.id, resolution: selected.resolution },
        nativeSession: token,
        appeals: [],
        next: 'sparse',
      });
      for (body of [
        { ...wire, appeals: [selected], selectedAppeal: undefined },
        { ...wire, appeals: [{ ...selected, source: { ...source, partition: 1 } }] },
        { ...wire, provenance: { ...provenance, actorId: 'foreign' } },
        { ...wire, selectedAppeal: { ...selected, source: { ...source, partition: 1 } } },
        { ...wire, selectedAppeal: { ...selected, source: { ...source, epoch: 2 } } },
        { ...wire, selectedAppeal: { ...selected, source: { ...source, position: '13' } } },
      ])
        expect(await read()).toMatchObject({ state: 'unavailable', appeals: [], next: null });
      body = wire;
      token = '';
      expect(await read()).toMatchObject({ state: 'unavailable', appeals: [] });
      expect(requests).toHaveLength(8);
      for (const request of requests) {
        expect(new URL(request.url).pathname).toBe(`/v1/${threadId ? 'threads/thread' : 'boards/board'}/appeals`);
        expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual({
          limit: '20',
          cursor: 'captured',
          inspect: row.id,
        });
        expect(request.headers.get('authorization')).toBe(authorization);
        expect(request.cache).toBe('no-store');
      }
    }
});
