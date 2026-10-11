import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';

test('a current maintainer privately PREVIEWs their authored no-notes Work without a work.read grant or anonymous-public evidence', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const fixture = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `recipe-publication-no-notes-${randomUUID()}`));
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  (fixture.env as typeof fixture.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  try {
    const accountPool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
    try { await accountPool.query('UPDATE "user" SET "emailVerified"=true WHERE id=$1', [fixture.account.a.id]); }
    finally { await accountPool.end(); }
    const control = await grantFixtureAuthority(fixture.accessPool, {
      scope: `agent:control:${fixture.actor}`, requireDispatch: true,
      representations: [{ principalId: fixture.principalId, actor: fixture.actor,
        action: 'agent.control', lifetime: 'infinity' }],
      grant: { actor: fixture.actor, action: 'agent.control', lifetime: 'infinity' },
    });
    const provision = randomUUID();
    await fixture.accessPool.query(`INSERT INTO access.agent_provision
      (id,principal_id,idempotency_key,request_digest,agent_id,agent_kind,display_name,
        principal_epoch,state,graph_data_epoch,graph_sequence,representation_id)
      VALUES ($1::uuid,$2,$1::text,$3,$4,'person','Private preview author',0,'active','fixture',1,$5)`,
    [provision, fixture.principalId, 'a'.repeat(64), fixture.actor, control.representationIds[0]]);
    const work = await fixture.json<{ work: string; mainVersion: string }>(await fixture.call(
      'POST', '/v1/works', await fixture.authoredBody({ language: 'en',
        profile: 'metadata-only-v1', title: 'Private flour pancakes',
        semanticTypes: ['https://schema.org/Recipe'], actingSubject: fixture.actor })), 201);
    const path = `/v1/recipes/works/${shortId(work.work)}`;
    const authorPath = `${path}?actingSubject=${encodeURIComponent(fixture.actor)}`;
    const created = await fixture.json<{ structure: string; revision: string }>(await fixture.call(
      'POST', '/v1/compositions', { profile: 'recipe-composition', work: work.work,
        mainVersion: work.mainVersion, actingSubject: fixture.actor }, `recipe-${randomUUID()}`), 201);
    const changed = await fixture.json<{ revision: string }>(await fixture.call('POST',
      `/v1/compositions/${shortId(created.structure)}/changes`, { profile: 'recipe-composition',
        expectedHead: created.revision, actingSubject: fixture.actor, operations: [
          { op: 'insert', parent: created.structure, position: 'last', role: 'ingredient',
            qualifier: { type: 'ingredient-line', originalText: { value: '2 cups flour', language: 'en' },
              amountLexical: '2', amount: { numerator: 2, denominator: 1 }, unitText: 'cups',
              optional: false, scaling: 'linear', substituteFor: [], parseStatus: 'parsed' } },
          { op: 'insert', parent: created.structure, position: 'last', role: 'step',
            qualifier: { type: 'recipe-step', instructionText: { value: 'Cook until golden.', language: 'en' },
              usesIngredient: [], media: [], scaling: 'linear' } },
        ] }, `recipe-${randomUUID()}`), 200);

    const page = await fixture.json<{ profile: string; revision: string;
      occurrences: Array<{ role: string }> }>(await fixture.call('GET', authorPath), 200);
    expect(page).toMatchObject({ profile: 'recipe-work-page-v1', revision: changed.revision });
    expect(page.occurrences.map(occurrence => occurrence.role)).toEqual(['ingredient', 'step']);
    const privateComposition = await fixture.json<{ revision: string }>(await fixture.call('GET',
      `/v1/compositions/${shortId(created.structure)}?actingSubject=${encodeURIComponent(fixture.actor)}`), 200);
    expect(privateComposition.revision).toBe(changed.revision);
    const header = await fixture.json<{ publicationState: string; disclosure: string }>(
      await fixture.call('GET', `/v1/works/${shortId(work.work)}?actingSubject=${encodeURIComponent(fixture.actor)}`), 200);
    expect(header).toMatchObject({ publicationState: 'unpublished', disclosure: 'restricted' });
    expect((await fixture.accessPool.query(`SELECT id FROM access.permission_grant
      WHERE recipient_subject=$1 AND scope_id=$2 AND action='work.read'`,
    [fixture.actor, `work:read:${work.work}`])).rows).toHaveLength(0);
    expect((await fixture.call('GET', path, undefined, randomUUID(), null)).status).toBe(404);
    expect((await fixture.call('GET', authorPath, undefined, randomUUID(), fixture.account.tokenB)).status).toBe(404);
    expect((await fixture.call('GET', `/v1/compositions/${shortId(created.structure)}`,
      undefined, randomUUID(), null)).status).toBe(404);

    await fixture.accessPool.query(`INSERT INTO access.scope_gate (id,open)
      VALUES ($1,false) ON CONFLICT (id) DO UPDATE SET open=false`, [`work:read:${work.work}`]);
    expect((await fixture.call('GET', authorPath)).status).toBe(404);
    await fixture.accessPool.query('UPDATE access.scope_gate SET open=true WHERE id=$1', [`work:read:${work.work}`]);
    expect((await fixture.call('GET', authorPath)).status).toBe(200);
    await grantFixtureAuthority(fixture.accessPool, {
      scope: `agent:control:${fixture.actor}`, requireDispatch: true,
      representations: [{ principalId: fixture.otherPrincipal, actor: fixture.actor,
        action: 'agent.control', lifetime: 'infinity' }],
      grant: { actor: fixture.actor, action: 'agent.control', lifetime: 'infinity' },
    });
    await fixture.accessPool.query('UPDATE access.representation SET active=false,generation=generation+1 WHERE id=$1',
      [control.representationIds[0]]);
    expect((await fixture.call('GET', authorPath)).status).toBe(404);
  } finally { await fixture.close(); }
}, 180_000);
