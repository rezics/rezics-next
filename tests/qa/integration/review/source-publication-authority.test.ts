import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { personaSessions, type PersonaSessions } from '../../support/personas.ts';

type Grant = {
  id: string;
  permission: string;
  issuerSubject: string;
  recipient: { principalId?: string };
  active: boolean;
  generation: string;
};
type Page = { authorityEpoch: string; items: Grant[]; nextCursor: string | null };
let sessions: PersonaSessions;

async function answer<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending;
  const raw = await response.text();
  expect(response.status, raw).toBe(status);
  return JSON.parse(raw) as T;
}

async function page(after?: string): Promise<Page> {
  const query = new URLSearchParams({
    profile: 'platform-grants-v1',
    issuerSubject: sessions.operator.actingSubject!,
    ...(after ? { after } : {}),
  });
  return answer(sessions.operator.main('GET', `/v1/access/grants?${query}`));
}

async function change(body: Record<string, unknown>): Promise<Response> {
  return sessions.operator.main('POST', '/v1/access/grant-changes', {
    profile: 'platform-grant-change-v1',
    issuerSubject: sessions.operator.actingSubject,
    expectedAuthorityEpoch: (await page()).authorityEpoch,
    ...body,
  });
}

beforeAll(async () => { sessions = await personaSessions('public'); }, 180_000);
afterAll(async () => { await sessions?.close(); });

test('revoked deployment designation cannot delegate publication using another ordinary platform grant', async () => {
  const grants: Grant[] = [];
  let cursor: string | undefined;
  do {
    const result = await page(cursor);
    grants.push(...result.items);
    cursor = result.nextCursor ?? undefined;
  } while (cursor);
  const designation = grants.find(grant => grant.active
    && grant.permission === 'platform:grant'
    && grant.issuerSubject === sessions.operator.actingSubject);
  if (!designation?.recipient.principalId) throw new Error('Missing deployment designation');
  const principalId = designation.recipient.principalId;
  const work = await answer<{ work: string }>(sessions.owner.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', title: 'Designation revocation regression',
    language: 'en', semanticTypes: ['https://schema.org/Recipe'],
    authoring: 'own-work', actingSubject: sessions.owner.actingSubject,
  }), 201);

  // Keep ordinary governance available while terminating the original designation.
  await answer(change({ action: 'create', grantId: randomUUID(),
    permission: 'platform:grant', scopeId: 'platform:access',
    recipient: { principalId }, validUntil: null }));
  const revoked = await answer<{ grant: Grant }>(change({ action: 'revoke',
    grantId: designation.id, expectedObjectGeneration: designation.generation }));
  expect(revoked.grant.active).toBe(false);

  const response = await change({ action: 'create', grantId: randomUUID(),
    permission: 'platform:resource:work.publish', scopeId: `work:publish:${work.work}`,
    recipient: { principalId }, validUntil: null });
  const raw = await response.text();
  expect(response.status, `Revoked deployment operator issued a publication mandate: ${raw}`).toBe(403);
  expect(JSON.parse(raw)).toMatchObject({ code: 'grant_denied' });
}, 60_000);
