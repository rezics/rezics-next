import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture } from '../fixtures/author-credit.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { changeAdmittedStructureMeasures }
  from '../../../services/main/src/modules/structure/change-admitted.ts';
import { readStructureMeasures } from '../../../services/main/src/modules/structure/read.ts';

test('RECIPE05: expected-head measure edits retain exact revisions and receipt replay', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `structure-measures-${randomUUID()}`));
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  try {
    const work = await f.json<{ work: string; mainVersion: string }>(await f.call('POST', '/v1/works', await f.authoredBody({ language: 'en',
      profile: 'metadata-only-v1', title: 'Measure revision',
      semanticTypes: ['https://schema.org/Recipe'], actingSubject: f.actor,
    })), 201);
    await f.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)',
      [`work:edit:${work.work}`]);
    await f.grant(`work:edit:${work.work}`, 'recipe.edit');
    const created = await f.json<{ structure: string; revision: string }>(await f.call('POST',
      '/v1/recipes', { owner: work.work, mainVersion: work.mainVersion, actingSubject: f.actor },
      `recipe-${randomUUID()}`), 201);
    const request = new Request('http://main.local/v1/recipes/measures', {
      headers: { authorization: `Bearer ${f.account.tokenA}` },
    });
    const measure = { kind: 'servings' as const, value: { numerator: 3, denominator: 2 },
      unitText: 'servings', basis: 'whole-recipe' as const, coverage: 'complete' as const,
      provenance: 'declared' as const };
    const intent = { structure: created.structure, expectedHead: created.revision,
      measures: [measure], actingSubject: f.actor, idempotencyKey: `measure-${randomUUID()}` };
    const change = () => changeAdmittedStructureMeasures(f.env, f.account.verifier, f.access,
      request, intent);
    const first = await change();
    expect(first).toMatchObject({ outcome: 'succeeded', replayed: false,
      expectedHead: created.revision });
    expect(first.revision).not.toBe(created.revision);
    expect(await change()).toMatchObject({ outcome: 'succeeded', replayed: true,
      revision: first.revision, receipt: first.receipt });
    const current = await readStructureMeasures(f.env, { structure: created.structure });
    expect(current).toMatchObject({ revision: first.revision, predecessor: created.revision,
      measures: [measure], cost: { pagesRead: 1, pagesWritten: 0 } });
    const old = await readStructureMeasures(f.env,
      { structure: created.structure, revision: created.revision });
    expect(old.measures).toEqual([]);
    expect(old.revision).toBe(created.revision);
    await expect(changeAdmittedStructureMeasures(f.env, f.account.verifier, f.access, request,
      { ...intent, idempotencyKey: `measure-${randomUUID()}` })).rejects.toThrow();
    const raced = await Promise.allSettled([1, 2].map(value =>
      changeAdmittedStructureMeasures(f.env, f.account.verifier, f.access, request,
        { ...intent, expectedHead: first.revision,
          measures: [{ ...measure, value: { numerator: value, denominator: 1 } }],
          idempotencyKey: `measure-${randomUUID()}` })));
    expect(raced.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((await readStructureMeasures(f.env, { structure: created.structure })).measures)
      .toHaveLength(1);
  } finally {
    await f.close();
  }
});
