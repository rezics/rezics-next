import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest } from '@rezics/definitions/bundled';
import { newId, routeOf } from '../../src/route/route.ts';
import { checkGrowth } from '../support/growth.ts';
import { seedCollectionGrowthPopulation } from './support/collection-growth-population.ts';
import { createCollectionRulesFixture } from './support/collection-rules-fixture.ts';

test('saved rule create/CAS/replay/denial stay indexed as unrelated rules, facts and receipts grow', async () => {
  const f = await createCollectionRulesFixture();
  try {
    const subjectId = await f.subject('Measured saved rule source');
    await f.entry(subjectId);
    const filter = { owner: { presence: true } };
    const draft = { membershipKind: 'dynamic', title: 'Measured saved rule', visibility: 'private', rule: { filter } };
    const route = routeOf(f.runtime.identity.ordinary.accountId)!;
    await checkGrowth(f.database, {
      name: 'saved dynamic Collection rule command points',
      scales: [64, 512, 4096],
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      async grow(database, scale, previous) {
        await seedCollectionGrowthPopulation(
          database,
          scale / 1024,
          previous / 1024,
          f.runtime.identity.ordinary.accountId,
          subjectId,
        );
        // Unrelated noise only. No seeded row establishes the positive command, source, grant or membership.
        const ids = Array.from({ length: scale - previous }, () => newId(route));
        await database.admin.query(
          `
          INSERT INTO library.collection
            (route,collection_id,curator_account_id,title,visibility,state,revision,member_count,order_epoch,
             created_at,updated_at,transaction_id,membership_kind,rule_filter,rule_sort,rule_source,rule_release_digest,rule_revision)
          SELECT $1,id,$2,'Unrelated saved rule','private','active',1,0,0,now(),now(),id,
                 'dynamic',$4::jsonb,'id','owner',$5,1 FROM unnest($3::uuid[]) noise(id)`,
          [route, f.runtime.identity.ordinary.accountId, ids, JSON.stringify(filter), bundledDigest],
        );
      },
      async operation() {
        const key = randomUUID();
        const made = await f.send('POST', '/v1/collections', draft, f.owner, key);
        expect(made.status).toBe(201);
        const { collection } = await made.json();
        expect((await f.send('POST', '/v1/collections', draft, f.owner, key)).status).toBe(201);
        const path = `/v1/collections/${collection.id}/rule`;
        const edit = { revision: 1, filter, sort: 'id' };
        const editKey = randomUUID();
        expect((await f.send('PUT', path, edit, f.owner, editKey)).status).toBe(200);
        expect((await f.send('PUT', path, edit, f.owner, editKey)).status).toBe(200);
        expect((await f.send('PUT', path, edit)).status).toBe(409);
        expect((await f.send('PUT', path, edit, f.other)).status).toBe(404);
        expect((await f.send('PUT', path, edit, f.reduced, editKey)).status).toBe(403);
      },
    });
  } finally {
    await f.close();
  }
}, 180_000);
