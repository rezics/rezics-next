import { expect, test } from 'bun:test';
import { appealClient } from './api.ts';

const realm = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const receiptId = '00000000-0000-4000-8000-0000000000aa';
const caseId = '00000000-0000-4000-8000-0000000000bb';
const moderator = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000cc';

function reading(appeal: Record<string, unknown>) {
  return {
    realm, receiptId, action: 'ban', reason: 'Posted the same chapter five times.',
    bannedUntil: null, permanent: true, happenedAt: '2026-10-01T12:00:00.000Z',
    decider: moderator, appeal,
  };
}

function responder(steps: { status: number; body: unknown }[]) {
  const seen: { method: string; key: string | null; body: unknown }[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({
      method: init?.method ?? 'GET',
      key: headers.get('idempotency-key'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null,
    });
    const step = steps.shift();
    if (!step) throw new Error('unexpected appeal request');
    return new Response(JSON.stringify(step.body), { status: step.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

const open = reading({ state: 'open', caseId, statement: 'I posted it once.' });

test('a sent appeal is read back without the decider, and a lost response can reuse its key', async () => {
  const { fetchImpl, seen } = responder([
    { status: 201, body: { state: 'open', caseId } },
    { status: 200, body: open },
    { status: 503, body: { code: 'governance_unavailable' } },
    { status: 409, body: { code: 'idempotency_conflict' } },
  ]);
  const client = appealClient(realm, receiptId, fetchImpl);
  const sent = await client.submit('I posted it once.', 'key-1');
  expect(sent.kind).toBe('sent');
  if (sent.kind !== 'sent') return;
  expect(sent.reading.appeal).toEqual({ state: 'open', caseId, statement: 'I posted it once.' });
  expect(JSON.stringify(sent.reading)).not.toContain(moderator);
  expect(seen[0]).toMatchObject({ method: 'POST', key: 'key-1', body: { statement: 'I posted it once.' } });
  expect(await client.submit('I posted it once.', 'key-1')).toEqual({ kind: 'failed', reuseKey: true });
  expect(await client.submit('I posted it once.', 'key-2')).toEqual({ kind: 'failed', reuseKey: false });
});

test('a second appeal finds the one already open instead of offering another', async () => {
  const { fetchImpl } = responder([
    { status: 409, body: { code: 'appeal_already_open' } },
    { status: 200, body: open },
    { status: 400, body: { code: 'invalid_appeal' } },
  ]);
  const client = appealClient(realm, receiptId, fetchImpl);
  const again = await client.submit('Please review this again.', 'key-3');
  expect(again.kind).toBe('sent');
  if (again.kind !== 'sent') return;
  expect(again.reading.appeal.state).toBe('open');
  expect(await client.submit(' ', 'key-4')).toEqual({ kind: 'invalid' });
});
