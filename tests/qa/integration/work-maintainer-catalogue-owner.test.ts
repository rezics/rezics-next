import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { memberFixture, nativeId } from '../../../services/main/tests/member-reply-fixture.ts';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';

const catalogueScope = 'work:create:catalogue-import';

test('a Work sealed through catalogue import has one owner, and two raw inserts leave one', async () => {
  const h = await memberFixture();
  try {
    const principal = await h.principal();
    const person = (await h.accessPool.query<{ id: string }>(
      'SELECT id FROM access.principal WHERE account_issuer = $1 AND account_subject = $2',
      [principal.issuer, principal.subject])).rows[0]!;
    await h.accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'work.create',clock_timestamp() + interval '1 hour')`,
    [randomUUID(), person.id, h.actor]);
    await h.accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,'work.create',clock_timestamp() + interval '1 hour')`,
    [randomUUID(), h.actor, catalogueScope]);
    await grantRecordedPlatformUse(h.accessPool, person.id, ['catalogue-import']);
    const spare = (await h.access.admitCatalogue(principal, h.actor, [
      { key: randomUUID(), digest: 'b'.repeat(64) },
    ]))[0];
    if (!spare || !('admission' in spare)) throw new Error(`catalogue admission denied: ${JSON.stringify(spare)}`);

    const imported = await h.post('/v1/work-imports', {
      actingSubject: h.actor,
      input: {
        profile: 'work-catalogue-import-v1', expectedWorkHead: null,
        title: `Imported ${randomUUID()}`, language: 'en', evidence: 'Catalogue source record',
        aliases: [], semanticTypes: [], credits: [], classifications: [],
      },
    });
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);
    expect(imported.body.status).toBe('succeeded');
    const work = imported.body.receipt.work as string;

    const owners = (await h.accessPool.query<{ agent: string }>(
      'SELECT agent FROM access.work_maintainer WHERE work = $1 AND owner', [work])).rows;
    expect(owners.map(row => row.agent)).toEqual([h.actor]);
    const created = (await h.accessPool.query<{ owner: string }>(
      `SELECT owner FROM access.work_maintainer_receipt WHERE work = $1 AND action = 'create'`, [work])).rows;
    expect(created).toEqual([{ owner: h.actor }]);
    expect(await h.maintainers.read(work)).toEqual({
      work, generation: '0', maintainers: [h.actor], owner: h.actor,
    });

    const id = work.slice(-36);
    const change = (action: 'add' | 'transfer' | 'remove', target: string, expected: string) => ({
      profile: 'work-maintainer-change-v1', work, actingSubject: h.actor, target, action,
      expectedGeneration: expected,
    });
    const added = await h.post('/v1/work-maintainer-changes', change('add', h.pen, '0'));
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body).toMatchObject({ generation: '1', owner: h.actor, replayed: false });
    expect(added.body.maintainers.sort()).toEqual([h.actor, h.pen].sort());
    const removed = await h.post('/v1/work-maintainer-changes', change('remove', h.pen, '1'));
    expect(removed.status, JSON.stringify(removed.body)).toBe(201);
    expect(removed.body).toMatchObject({ generation: '2', owner: h.actor, maintainers: [h.actor] });
    const again = await h.post('/v1/work-maintainer-changes', change('add', h.pen, '2'));
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    const handed = await h.post('/v1/work-maintainer-changes', change('transfer', h.pen, '3'));
    expect(handed.status, JSON.stringify(handed.body)).toBe(201);
    expect(handed.body).toMatchObject({ generation: '4', owner: h.pen, maintainers: [h.pen] });
    const view = await h.get(`/v1/works/${id}/maintainers`);
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.body).toMatchObject({ generation: '4', owner: h.pen, maintainers: [h.pen] });

    const fresh = nativeId();
    await h.accessPool.query(`INSERT INTO access.work_maintainer_set
      (work, main_version, creation_admission) VALUES ($1,$2,$3)`,
    [fresh, nativeId(), spare.admission.id]);
    await h.accessPool.query('INSERT INTO access.work_maintainer (work, agent) VALUES ($1,$2)', [fresh, h.actor]);
    await h.accessPool.query('INSERT INTO access.work_maintainer (work, agent) VALUES ($1,$2)', [fresh, h.pen]);
    const raw = (await h.accessPool.query<{ agent: string; owner: boolean }>(
      'SELECT agent, owner FROM access.work_maintainer WHERE work = $1 ORDER BY agent', [fresh])).rows;
    expect(raw).toHaveLength(2);
    expect(raw.filter(row => row.owner).map(row => row.agent)).toEqual([h.actor]);
    const guest = await h.agent('Second owner');
    await expect(h.accessPool.query(
      'INSERT INTO access.work_maintainer (work, agent, owner) VALUES ($1,$2,true)',
      [fresh, guest])).rejects.toThrow(/work_maintainer_one_owner/);
  } finally { await h.close(); }
}, 180_000);
