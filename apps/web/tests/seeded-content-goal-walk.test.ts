import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  firstScopeRows,
  grantReceiptKey,
  jwtAccountId,
  mentionBody,
  publicFields,
  publicStackLog,
  requireStatus,
  summarizeWalk,
  waitForNotices,
  walkWorkingDirectory,
  withIssuerSeedProxy,
} from '../scripts/seeded-content-goal-walk.ts';

test('the Content Goal walk names every first-scope row and summarises passing, total and slowest failure', () => {
  expect(walkWorkingDirectory()).toBe(resolve(import.meta.dir, '..'));
  expect(firstScopeRows()).toHaveLength(18);
  expect(firstScopeRows()).toEqual([
    'threads-and-boards',
    'exact-revisions',
    'board-paging',
    'container-disclosure',
    'late-revocation',
    'edit-history-return',
    'watches-and-reactions',
    'takedown-erasure',
    'author-erasure',
    'media',
    'realms-and-spaces',
    'ratings-and-reviews',
    'work-to-review',
    'moderation-reports-appeals',
    'notices',
    'home-discovery',
    'independent-queues',
    'persona-matrix',
  ]);
  const summary = summarizeWalk([
    { row: 'threads-and-boards', status: 'passing', durationMs: 1200, observed: { threads: 1 } },
    { row: 'notices', status: 'failing', durationMs: 4800, defect: 'inbox unbound', observed: { status: 404 } },
    { row: 'media', status: 'passing', durationMs: 900, observed: { state: 'reserved' } },
  ]);
  expect(summary).toEqual({
    passing: 2,
    total: 3,
    slowestFailure: { row: 'notices', durationMs: 4800, defect: 'inbox unbound' },
  });
  expect(jwtAccountId('header.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEifQ.sig')).toBe(
    '00000000-0000-4000-8000-000000000001',
  );
  expect(publicFields({ token: 'secret', threadId: 'shown' })).toEqual({ threadId: 'shown' });
  const source = readFileSync(resolve(import.meta.dir, '../scripts/seeded-content-goal-walk.ts'), 'utf8');
  expect(source).toContain('retireStaleSeedJournals');
  expect(source).toContain('startSeededFrontends');
  expect(source).toContain('waitUntilWalkReady');
  expect(source).toContain('waitUntilIdentityBootstrapRemainingZero');
  expect(source).toContain('identityEpochBootstrapRemaining');
  expect(source).toContain('published-post');
  expect(source).toContain('moderation-decisions');
  expect(source).toContain('notifications:markSeen');
  expect(source).toContain('mention');
  expect(source).toContain('independent');
  expect(source).toContain('boards/${boardId}:takeDown');
  expect(source).toContain('html[data-hydrated]');
  expect(source).toContain("getByRole('button', { name: 'Sign in', exact: true })");
  expect(source).toContain('withIssuerSeedProxy');
  expect(source).toContain('walkIssuerForward');
  expect(source).toContain('AUTH_ORIGIN: process.env.REZICS_LOCAL_STACK_ISSUER_ORIGIN');
  expect(source).not.toMatch(/AUTH_JWKS_URL\s*=/);
});

test('the deferred issuer origin forwards seed credential POSTs to native Auth', async () => {
  let received = '';
  const native = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      received = await request.text();
      return Response.json({ ok: true, path: new URL(request.url).pathname });
    },
  });
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const issuerPort = reservation.port;
  await reservation.stop(true);
  const previousIssuer = process.env.REZICS_LOCAL_STACK_ISSUER_ORIGIN;
  const previousNative = process.env.REZICS_LOCAL_STACK_NATIVE_ORIGIN;
  process.env.REZICS_LOCAL_STACK_ISSUER_ORIGIN = `http://127.0.0.1:${issuerPort}`;
  process.env.REZICS_LOCAL_STACK_NATIVE_ORIGIN = `http://127.0.0.1:${native.port}`;
  try {
    const observed = await withIssuerSeedProxy(async () => {
      const response = await fetch(`http://127.0.0.1:${issuerPort}/signin/key`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: `http://127.0.0.1:${issuerPort}`,
        },
        body: '{"account_id":"a"}',
      });
      return (await response.json()) as { ok: boolean; path: string };
    });
    expect(observed).toEqual({ ok: true, path: '/signin/key' });
    expect(received).toBe('{"account_id":"a"}');
  } finally {
    await native.stop(true);
    if (previousIssuer === undefined) delete process.env.REZICS_LOCAL_STACK_ISSUER_ORIGIN;
    else process.env.REZICS_LOCAL_STACK_ISSUER_ORIGIN = previousIssuer;
    if (previousNative === undefined) delete process.env.REZICS_LOCAL_STACK_NATIVE_ORIGIN;
    else process.env.REZICS_LOCAL_STACK_NATIVE_ORIGIN = previousNative;
  }
});

test('mention documents and ordinary grant receipts match the Accounts producer contract', () => {
  const accountId = '00000000-0000-4000-8000-000000000002';
  const document = mentionBody('Mention delivery', [accountId.toUpperCase()]);
  expect(JSON.stringify(document)).toContain('"type":"mention"');
  expect(JSON.stringify(document)).toContain(accountId);
  expect(grantReceiptKey({ route: 18, id: 'board-1' }, accountId, 'moderation:takedown')).toBe(
    `accounts.grant:18:board-1:${accountId}:moderation:takedown`,
  );
  expect(requireStatus({ status: 200, value: { ok: true } }, 'anonymous space')).toEqual({ ok: true });
});

test('waitForNotices returns the delivered item once the default worker has written it', async () => {
  let calls = 0;
  const found = await waitForNotices(
    async () => {
      calls += 1;
      return {
        status: 200,
        items: calls < 2 ? [] : [{ id: 'notice-1', kind: 'reply', unread: true }],
      };
    },
    (item) => item.kind === 'reply',
    'reply notice',
    5_000,
  );
  expect(found).toEqual([{ id: 'notice-1', kind: 'reply', unread: true }]);
  expect(calls).toBe(2);
});

test('returned startup evidence preserves phase diagnostics without the native bootstrap password', () => {
  expect(publicStackLog('stack: identity ready\nPassword: bootstrap-secret\nworker: starting\n')).toBe(
    'stack: identity ready\nPassword: [redacted]\nworker: starting\n',
  );
});
