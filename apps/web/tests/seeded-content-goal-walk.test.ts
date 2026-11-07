import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  firstScopeRows,
  grantReceiptKey,
  jwtAccountId,
  mentionBody,
  publicFields,
  requireStatus,
  summarizeWalk,
  waitForNotices,
  walkWorkingDirectory,
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
  expect(source).toContain('published-post');
  expect(source).toContain('moderation-decisions');
  expect(source).toContain('notifications:markSeen');
  expect(source).toContain('mention');
  expect(source).toContain('independent');
  expect(source).toContain('boards/${boardId}:takeDown');
  expect(source).toContain('html[data-hydrated]');
  expect(source).toContain("getByRole('button', { name: 'Sign in', exact: true })");
  expect(source).not.toMatch(/AUTH_JWKS_URL\s*=/);
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
