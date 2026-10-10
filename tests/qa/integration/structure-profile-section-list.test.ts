import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';

type Created = { structure: string; revision: string; occurrences?: string[] };
type Page = { occurrences: Array<{ occurrence: string; role: string; target?: string;
  qualifier?: { type: string; id?: string; values?: { note?: string } } }> };

test('a section list is created, noted, updated, withheld and refused as a cycle', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `structure-profile-section-list-${randomUUID()}`));
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  (f.env as typeof f.env & { structureObjects: unknown }).structureObjects = objects;
  try {
    const work = async (title: string) => {
      const created = await f.json<{ work: string; mainVersion: string }>(await f.call('POST', '/v1/works',
        await f.authoredBody({ profile: 'metadata-only-v1', language: 'en', title,
          semanticTypes: ['https://schema.org/Book'], actingSubject: f.actor })), 201);
      await f.grant(`work:edit:${created.work}`, 'work.edit');
      await f.grant(`work:read:${created.work}`, 'work.read');
      return created;
    };
    const owner = await work('Section list');
    const visible = await work('Visible entry');
    const hidden = await work('Hidden entry');
    const third = await work('Third entry');
    const created = await f.json<Created>(await f.call('POST', '/v1/compositions', {
      profile: 'section-list-v1', work: owner.work, mainVersion: owner.mainVersion, actingSubject: f.actor,
    }), 201);
    const change = async (expectedHead: string, operations: object[]) => f.json<Created>(await f.call('POST',
      `/v1/compositions/${shortId(created.structure)}/changes`, {
        profile: 'section-list-v1', actingSubject: f.actor, expectedHead, operations }), 200);
    const sections = await change(created.revision, [
      { op: 'insert', role: 'section', parent: created.structure, position: 'last' },
      { op: 'insert', role: 'section', parent: created.structure, position: 'last' },
    ]);
    const [sectionA, sectionB] = sections.occurrences ?? [];
    const entries = await change(sections.revision, [
      { op: 'insert', role: 'entry', parent: sectionA, position: 'last', target: visible.work, qualifier: { note: 'first' } },
      { op: 'insert', role: 'entry', parent: sectionA, position: 'last', target: hidden.work, qualifier: { note: 'second' } },
      { op: 'insert', role: 'entry', parent: sectionB, position: 'last', target: third.work, qualifier: { note: 'third' } },
    ]);
    const [first] = entries.occurrences ?? [];
    const updated = await change(entries.revision, [
      { op: 'update', occurrence: first, qualifier: { note: 'revised' } },
    ]);
    const read = async (parent: string, token = f.account.tokenA) => f.json<Page>(await f.call('GET',
      `/v1/compositions/${shortId(created.structure)}?actingSubject=${encodeURIComponent(f.actor)}&parent=${encodeURIComponent(parent)}`,
      undefined, randomUUID(), token), 200);
    const editor = await read(sectionA!);
    expect(editor.occurrences.map(item => item.qualifier?.values?.note)).toEqual(['revised', 'second']);
    await f.accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'work.read', now() + interval '1 hour')`, [randomUUID(), f.otherPrincipal, f.actor]);
    // Creation already granted this subject every Work. Another grant to the same
    // recipient cannot withhold one of them; revoke the hidden Work instead.
    await f.accessPool.query('DELETE FROM access.permission_grant WHERE scope_id = $1',
      [`work:read:${hidden.work}`]);
    const withheld = await read(sectionA!, f.account.tokenB);
    expect(withheld.occurrences.map(item => item.target)).toEqual([visible.work]);
    const cycle = await f.call('POST', `/v1/compositions/${shortId(created.structure)}/changes`, {
      profile: 'section-list-v1', actingSubject: f.actor, expectedHead: updated.revision,
      operations: [{ op: 'insert', role: 'entry', parent: sectionB, position: 'last',
        target: owner.work, qualifier: { note: 'itself' } }] });
    expect(cycle.status).toBe(409);
  } finally { await f.close(); }
}, 180_000);
