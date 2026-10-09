import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { NotificationDispatcher } from '../../../services/main/src/modules/notification/dispatcher.ts';
import { NotificationStore, type NotificationEvent } from '../../../services/main/src/modules/notification/store.ts';
import { contentSubjectReader } from '../../../services/main/src/modules/notification/subjects.ts';
import { mirrorAccountDeletionIntent } from '../../../services/main/src/modules/outbox/account-deletion-journal.ts';
import { FakeDeliveryProvider } from '../support/fake-delivery.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const issuer = 'https://account.notification-erasure.test';

test('GOV07/OPS11: erased subjects and recipients stay erased across history pins and a restored Access backup', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Use the QA fault/recovery tier');
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['access', 'content', 'relay'], 'owner');
  const contentPool = new Pool({ connectionString: databases.urls.content, max: 4 });
  const relay = new Pool({ connectionString: databases.urls.relay, max: 2 });
  const provider = new FakeDeliveryProvider();
  let pools: Pool[] = [];
  try {
    await migrateContent(contentPool);
    const content = new ContentCore(contentPool);
    const subjects = contentSubjectReader(content, async (_principal, ids) => new Set(ids));
    const owner = (url: string) => {
      const pool = new Pool({ connectionString: url, max: 4 });
      pools.push(pool);
      return { pool, store: new NotificationStore(pool),
        dispatcher: new NotificationDispatcher(pool, provider, subjects, { retryMs: 0 }) };
    };
    let live = owner(databases.urls.access);
    const users = { a: { issuer, subject: `a-${randomUUID()}` }, b: { issuer, subject: `b-${randomUUID()}` } };
    for (const user of [users.a, users.b]) {
      await live.store.registerEndpoint(user, { channel: 'email', deviceId: null, address: null,
        addressDigest: digest(user.subject), lockScreenDisclosure: false });
    }
    const principalId = async (pool: Pool, user: { subject: string }) => (await pool.query<{ id: string }>(
      'SELECT id FROM access.principal WHERE account_issuer = $1 AND account_subject = $2',
      [issuer, user.subject])).rows[0]!.id;
    const a = await principalId(live.pool, users.a);
    const b = await principalId(live.pool, users.b);
    const saved = await content.saveDraft({ operationId: `notification-erasure-${randomUUID()}`,
      variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId: `https://rezics.com/id/${randomUUID()}`,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, model: 'content-shape-v1', sourceRevision: null,
      provenance: { fixture: 'notification-erasure' }, serializedJson: JSON.stringify({ title: 'Erasable title' }) });
    const revision = saved.revisionId!;
    // The item pins the exact revision (history pin); no rendered copy is stored.
    const event = (recipients: string[]): NotificationEvent => ({ sourceOwner: 'content',
      sourceEvent: `erasure-${randomUUID()}`, purpose: 'social', topic: 'reply',
      subject: { owner: 'content', ref: `urn:rezics:content:${revision}`, revision },
      disclosureBasis: 'content-draft-reader', recipients });
    const pinned = event([a, b]);
    const [pinnedA, pinnedB] = await live.store.enqueue(pinned);
    expect(pinnedA!.deliveries + pinnedB!.deliveries).toBe(2);
    const columns = (await live.pool.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'access' AND table_name IN ('notification_item', 'notification_delivery',
        'notification_attempt')`)).rows.map(row => row.column_name);
    expect(columns.some(name => /body|payload|title|rendered/.test(name))).toBe(false);

    // Backup taken while both deliveries are pending and the subject is intact.
    const backupUrl = await databases.snapshot('access', async () => {
      await Promise.all(pools.map(pool => pool.end())); pools = [];
    });
    live = owner(databases.urls.access);

    // The subject is erased by its owner (Content tombstone commits with the transition).
    const client = await contentPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL
        WHERE id = $1`, [revision]);
      await client.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
        VALUES ($1, $2, 1)`, [revision, randomUUID()]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }

    // Recipient b's Account is erased: Access fence plus the relay-retained intent outside Access backups.
    const fence = await new AccessAdmissionRegistry(live.pool).strongDeactivateAccountSubject(issuer, users.b.subject);
    await mirrorAccountDeletionIntent(live.pool, relay, fence!.principalId, fence!.enforcementEpoch);

    // Live owner: the pinned revision resolves to erased and nothing is sent.
    expect(await live.dispatcher.runOnce()).toMatchObject({ claimed: 1, cancelled: 2, delivered: 0 });
    const reasons = async (pool: Pool) => (await pool.query<{ principal_id: string; state: string;
      cancel_reason: string | null }>(`SELECT principal_id, state, cancel_reason FROM access.notification_delivery
      ORDER BY principal_id`)).rows;
    expect((await reasons(live.pool)).map(row => [row.principal_id === a ? 'a' : 'b', row.state, row.cancel_reason])
      .sort()).toEqual([['a', 'cancelled', 'subject_erased'], ['b', 'cancelled', 'recipient_erased']]);
    const page = await live.store.readStream(users.a, null);
    expect(page.items).toEqual([expect.objectContaining({ sequence: '1', state: 'erased', subject: null })]);
    expect(provider.calls.send).toBe(0);

    // Restore the pre-erasure Access backup: items are active and deliveries pending again.
    await Promise.all(pools.map(pool => pool.end())); pools = [];
    const restored = owner(backupUrl);
    expect((await reasons(restored.pool)).map(row => row.state)).toEqual(['pending', 'pending']);
    expect((await restored.pool.query('SELECT active FROM access.principal WHERE id = $1', [b])).rows[0].active)
      .toBe(true);
    // Before dispatch resumes, retained erasure intents are reconciled from the relay journal.
    expect(await restored.dispatcher.reconcileRetainedErasures(relay)).toEqual({ recipients: 1, deliveries: 1,
      items: 1 });
    expect(await restored.dispatcher.reconcileRetainedErasures(relay)).toEqual({ recipients: 1, deliveries: 0,
      items: 0 });
    // The restored pin for a still resolves through the Content owner, which keeps the erasure.
    expect(await restored.dispatcher.runOnce()).toMatchObject({ claimed: 1, cancelled: 1, delivered: 0 });
    expect((await reasons(restored.pool)).map(row => [row.principal_id === a ? 'a' : 'b', row.cancel_reason]).sort())
      .toEqual([['a', 'subject_erased'], ['b', 'recipient_erased']]);
    expect(provider.calls.send).toBe(0);
    expect((await content.readExactBatch([revision], async ids => new Set(ids)))[0]!.status).toBe('erased');
    // Replaying the original domain event after restore finds the erased items and adds no delivery.
    const replay = await restored.store.enqueue({ ...pinned, recipients: [a, b] });
    expect(replay.map(item => [item.replayed, item.deliveries])).toEqual([[true, 1], [true, 1]]);
    expect((await restored.pool.query(`SELECT count(*)::int AS open FROM access.notification_delivery
      WHERE state IN ('pending', 'sending', 'uncertain')`)).rows[0].open).toBe(0);
  } finally {
    await Promise.all([...pools.map(pool => pool.end()), contentPool.end(), relay.end()]);
    await databases.close();
  }
}, 180_000);
