import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { AdmissionDenied } from '../../../services/main/src/modules/access/admission.ts';
import { receiptFamilyFor } from '../../../services/main/src/modules/access/receipt-families.ts';
import { memberFixture } from '../../../services/main/tests/member-reply-fixture.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

test('the Work owner removes a co-maintainer once, and that maintainer cannot write again', async () => {
  const h = await memberFixture();
  try {
    const principal = await h.principal();
    const outsider = await h.agent('Outsider');
    const id = h.work.work.slice(-36);
    const view = async () => {
      const response = await h.get(`/v1/works/${id}/maintainers`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body;
    };
    const change = (action: 'add' | 'transfer' | 'remove', acting: string, target: string, expected: string) => ({
      profile: 'work-maintainer-change-v1', work: h.work.work, actingSubject: acting, target, action,
      expectedGeneration: expected,
    });
    const send = (body: object, key = randomUUID()) => h.post('/v1/work-maintainer-changes', body, key);

    const opened = await view();
    expect(opened).toMatchObject({ generation: '0', owner: h.actor, maintainers: [h.actor] });
    const sole = await send(change('remove', h.actor, h.actor, '0'));
    expect(sole.status, JSON.stringify(sole.body)).toBe(409);
    expect(sole.body.code).toBe('controller_continuity');
    expect(await view()).toMatchObject({ generation: '0', owner: h.actor, maintainers: [h.actor] });

    const added = await send(change('add', h.actor, h.pen, '0'));
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body).toMatchObject({ generation: '1', owner: h.actor, replayed: false });
    expect(added.body.maintainers.sort()).toEqual([h.actor, h.pen].sort());
    const denied = await send(change('remove', h.pen, h.actor, '1'));
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(denied.body.code).toBe('authority_denied');
    const self = await send(change('remove', h.actor, h.actor, '1'));
    expect(self.status, JSON.stringify(self.body)).toBe(409);
    expect(self.body.code).toBe('idempotency_conflict');
    const stale = await send(change('remove', h.actor, h.pen, '0'));
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(stale.body.code).toBe('idempotency_conflict');
    const missing = await send(change('remove', h.actor, outsider, '1'));
    expect(missing.status, JSON.stringify(missing.body)).toBe(409);
    expect(missing.body.code).toBe('idempotency_conflict');
    expect(await view()).toMatchObject({ generation: '1', owner: h.actor });
    expect((await view()).maintainers.sort()).toEqual([h.actor, h.pen].sort());

    const selected = await h.post('/v1/publication-selections', { ...h.selection, actingSubject: h.pen });
    expect(selected.status, JSON.stringify(selected.body)).toBe(201);
    expect(await h.access.canEditWork(principal, h.pen, h.work.work)).toBe(true);
    const held = await h.access.register({ principal, actingSubject: h.pen, action: 'work.edit',
      scope: `work:edit:${h.work.work}`, requestDigest: digest(`held:${h.work.work}`), idempotencyKey: randomUUID() });
    const busy = await h.access.register({ principal, actingSubject: h.pen, action: 'work.edit',
      scope: `work:edit:${h.work.work}`, requestDigest: digest(`busy:${h.work.work}`), idempotencyKey: randomUUID() });
    await h.access.claim(busy.id, busy.requestDigest, principal);
    const blocked = await send(change('remove', h.actor, h.pen, '1'));
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
    expect(await view()).toMatchObject({ generation: '1', owner: h.actor });
    await h.access.recordGraphOutcome(busy.id, { outcome: 'cancelled', admissionId: busy.id,
      requestDigest: busy.requestDigest, authorityEpoch: busy.authorityEpoch, scope: busy.scope,
      receipt: `urn:rezics:receipt:${digest(`${busy.id}\0${receiptFamilyFor(busy.action)}`)}`,
      dataEpoch: h.env.lineage.dataEpoch, sequence: '1' });

    const key = randomUUID();
    const removed = await send(change('remove', h.actor, h.pen, '1'), key);
    expect(removed.status, JSON.stringify(removed.body)).toBe(201);
    expect(removed.body).toMatchObject({ generation: '2', owner: h.actor, maintainers: [h.actor], replayed: false });
    const replay = await send(change('remove', h.actor, h.pen, '1'), key);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body).toMatchObject({ receipt: removed.body.receipt, generation: '2', owner: h.actor,
      maintainers: [h.actor], replayed: true });
    const clash = await send(change('remove', h.actor, outsider, '2'), key);
    expect(clash.status, JSON.stringify(clash.body)).toBe(409);
    expect(clash.body.code).toBe('idempotency_conflict');
    const readd = await send(change('add', h.pen, h.actor, '2'));
    expect(readd.status, JSON.stringify(readd.body)).toBe(403);
    expect(readd.body.code).toBe('authority_denied');
    const again = await h.post('/v1/publication-selections', { ...h.selection, actingSubject: h.pen,
      expectedSelectionHead: selected.body.selection });
    expect(again.status, JSON.stringify(again.body)).toBe(403);
    await expect(h.access.claim(held.id, held.requestDigest, principal)).rejects.toBeInstanceOf(AdmissionDenied);
    expect(await h.access.canEditWork(principal, h.pen, h.work.work)).toBe(false);
    expect(await h.access.canEditWork(principal, h.actor, h.work.work)).toBe(true);
    const anonymous = await h.app.handle(new Request(`http://main.local/v1/works/${id}/maintainers`));
    expect(anonymous.status).toBe(200);
    expect(await anonymous.json()).toMatchObject({ owner: h.actor, maintainers: [h.actor] });

    const guest = await h.agent('Guest');
    const desk = await h.agent('Desk', 'organization');
    const withDesk = await send(change('add', h.actor, desk, '2'));
    expect(withDesk.status, JSON.stringify(withDesk.body)).toBe(201);
    expect(withDesk.body.owner).toBe(h.actor);
    const left = await send(change('transfer', desk, guest, '3'));
    expect(left.status, JSON.stringify(left.body)).toBe(201);
    expect(left.body.owner).toBe(h.actor);
    expect(left.body.maintainers.sort()).toEqual([h.actor, guest].sort());
    const handed = await send(change('transfer', h.actor, guest, '4'));
    expect(handed.status, JSON.stringify(handed.body)).toBe(201);
    expect(handed.body).toMatchObject({ generation: '5', owner: guest, maintainers: [guest] });
    const former = await send(change('remove', h.actor, guest, '5'));
    expect(former.status, JSON.stringify(former.body)).toBe(403);

    await proveOwnerBackfill(h);
  } finally { await h.close(); }
}, 180_000);

async function proveOwnerBackfill(h: Awaited<ReturnType<typeof memberFixture>>) {
  async function work(title: string) {
    const created = await h.post('/v1/works', { ...h.workBody, title, actingSubject: h.actor });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.work as string;
  }
  const send = (body: object) => h.post('/v1/work-maintainer-changes', body);
  const creatorOnly = await work('Creator only');
  const handed = await work('Handed over');
  const handedAdd = await send({ profile: 'work-maintainer-change-v1', work: handed, actingSubject: h.actor,
    target: h.pen, action: 'add', expectedGeneration: '0' });
  expect(handedAdd.status, JSON.stringify(handedAdd.body)).toBe(201);
  const handedOver = await send({ profile: 'work-maintainer-change-v1', work: handed, actingSubject: h.actor,
    target: h.pen, action: 'transfer', expectedGeneration: '1' });
  expect(handedOver.status, JSON.stringify(handedOver.body)).toBe(201);
  const departed = await work('Creator departed');
  const org = await h.agent('Earliest org', 'organization');
  const first = await send({ profile: 'work-maintainer-change-v1', work: departed, actingSubject: h.actor,
    target: h.pen, action: 'add', expectedGeneration: '0' });
  expect(first.status, JSON.stringify(first.body)).toBe(201);
  const second = await send({ profile: 'work-maintainer-change-v1', work: departed, actingSubject: h.actor,
    target: org, action: 'add', expectedGeneration: '1' });
  expect(second.status, JSON.stringify(second.body)).toBe(201);
  const coTransfer = await work('Co-maintainer transfer');
  const successor = await h.agent('Successor');
  const coAdd = await send({ profile: 'work-maintainer-change-v1', work: coTransfer, actingSubject: h.actor,
    target: h.pen, action: 'add', expectedGeneration: '0' });
  expect(coAdd.status, JSON.stringify(coAdd.body)).toBe(201);
  const coLeft = await send({ profile: 'work-maintainer-change-v1', work: coTransfer, actingSubject: h.pen,
    target: successor, action: 'transfer', expectedGeneration: '1' });
  expect(coLeft.status, JSON.stringify(coLeft.body)).toBe(201);
  expect(coLeft.body.owner).toBe(h.actor);

  const migration = await Bun.file(new URL('../../../services/main/migrations/access/1782_work_maintainer_owner.sql', import.meta.url)).text();
  const backfill = migration.slice(migration.indexOf('WITH latest_transfer'), migration.indexOf('CREATE UNIQUE')).trim();
  const client = await h.accessPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM access.work_maintainer WHERE work = $1 AND agent = $2', [departed, h.actor]);
    await client.query('UPDATE access.work_maintainer SET owner = false');
    await client.query(backfill);
    const owners = async (work: string) => (await client.query<{ agent: string }>(
      'SELECT agent FROM access.work_maintainer WHERE work = $1 AND owner', [work])).rows.map(row => row.agent);
    expect(await owners(creatorOnly)).toEqual([h.actor]);
    expect(await owners(handed)).toEqual([h.pen]);
    expect(await owners(departed)).toEqual([h.pen]);
    expect(await owners(coTransfer)).toEqual([successor]);
    await client.query('ROLLBACK');
  } finally { client.release(); }
}
