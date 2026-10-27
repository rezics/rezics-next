import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { mergeSubjects, SubjectRedirectError } from '../../src/semantic/merges.ts';
import { readSubjectReference } from '../../src/semantic/references.ts';
import { newId } from '../../src/route/route.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { observeSql } from '../content/support/sql-observer.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const actor: AccountActor = {
  kind: 'account', accountId: newId(4112), clientId: 'reference-contract',
  scopes: ['subject:create', 'subject:read', 'subject:merge'], requestedBy: null, authnEpoch: 1,
};
beforeAll(async () => { await bootstrapRelease(pool, bundledRelease); });
afterAll(async () => { await pool.end(); });
const digest = (text: string) => createHash('sha256').update(text).digest();
async function subject(route: number) {
  const id = newId(route);
  const result = await createSubject(pool, {
    actor, target: { route, id }, idempotencyKey: randomUUID(), digest: digest(id),
    item: { type: 'schema:Book', labels: { en: 'A reference with paused projections' } },
    release: { digest: bundledDigest, release: bundledRelease }, authorize: async () => true,
  });
  return { id, component: result.component };
}
test('authorized references resolve live identities without projection or rendering reads', async () => {
  const live = await subject(4160);
  const observer = observeSql(pool);
  try {
    let calls = 0;
    const result = await readSubjectReference(pool, live.id, async (client) => {
      calls++;
      const isolation = await client.query('SHOW transaction_isolation');
      expect(isolation.rows[0]?.transaction_isolation).toBe('repeatable read');
      return true;
    });
    expect(result).toEqual({ id: live.id, component: live.component });
    expect(calls).toBe(1);
    expect(await readSubjectReference(pool, live.id, async () => false)).toBeNull();
    expect(await readSubjectReference(pool, newId(4160), async () => true)).toBeNull();
    expect(await readSubjectReference(pool, 'invalid', async () => true)).toBeNull();
    const prohibited = observer.records.filter(({ statement }) =>
      /core\.consumer_checkpoint|semantic\.(?:fact|outbound_link|inbound_link|merge_member|definition|summary)\b|projection_pending/i.test(statement),
    );
    expect(prohibited).toHaveLength(0);
  } finally { await observer.close(); }
}, 60_000);
test('reference redirects require source authorization and separately anchored survivor authorization', async () => {
  const source = await subject(4176);
  const survivor = await subject(4192);
  await mergeSubjects(pool, {
    subjects: [source.id, survivor.id], survivor: survivor.id, actor,
    idempotencyKey: randomUUID(), digest: digest(source.id + survivor.id),
    release: { digest: bundledDigest, release: bundledRelease },
    authorization: {
      action: 'subject:merge', resource: { route: 0, id: GLOBAL_CONTEXT },
      denied: () => new Error('Fixture merge denied'), async authorize() { return 'execute'; },
    },
  });
  const observer = observeSql(pool);
  try {
    expect(await readSubjectReference(pool, source.id, async () => false)).toBeNull();
    const redirect = await readSubjectReference(pool, source.id, async () => true).catch((error: unknown) => error);
    expect(redirect).toBeInstanceOf(SubjectRedirectError);
    expect((redirect as SubjectRedirectError).from).toBe(source.id);
    expect((redirect as SubjectRedirectError).to).toBe(survivor.id);
    expect(await readSubjectReference(pool, survivor.id, async () => false)).toBeNull();
    expect(await readSubjectReference(pool, survivor.id, async () => true)).toHaveProperty('id', survivor.id);
    expect(observer.records.filter(({ statement }) =>
      /core\.consumer_checkpoint|semantic\.(?:fact|outbound_link|inbound_link|merge_member|definition|summary)\b|projection_pending/i.test(statement),
    )).toHaveLength(0);
  } finally { await observer.close(); }
}, 60_000);
