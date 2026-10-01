import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { createAgentGraph } from '../../../services/main/src/modules/agent/graph.ts';
import { agentProvisionDigest } from '../../../services/main/src/modules/agent/provision.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { authorCreditFixture, author } from '../fixtures/author-credit.ts';

test('G-327 direct authoring commits one native author credit; source adoption does not credit the importer', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const directory = join(resolve('.temp'), `credit-creation-${randomUUID()}`);
  const f = await authorCreditFixture(Bun.env as Record<string, string>, directory);
  try {
    const agent = { kind: 'person' as const, displayName: 'Lin Mei' };
    await createAgentGraph(f.env, { id: randomUUID(), agent: f.actor,
      ...agent, digest: agentProvisionDigest(agent) });
    const input = { profile: 'metadata-only-v1', language: 'en', authoring: 'own-work', title: 'An authored serial',
      semanticTypes: ['https://schema.org/Book'], actingSubject: f.actor };
    const key = randomUUID();
    const created = await f.json<{ work: string }>(await f.call('POST', '/v1/works', input, key), 201);
    expect(await f.json<{ work: string }>(await f.call('POST', '/v1/works', input, key), 200))
      .toMatchObject({ work: created.work });
    const queryCredits = async (work: string) => (await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      PREFIX schema: <https://schema.org/> SELECT ?credit ?agent ?role WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?credit a rv:NativeAgentCredit ; rv:work ${iri(work)} ;
        rv:agent ?agent ; schema:roleName ?role . } }`)).results?.bindings ?? [];
    const credits = await queryCredits(created.work);
    expect(credits).toHaveLength(1);
    expect(credits[0]?.agent?.value).toBe(f.actor);
    expect(credits[0]?.role?.value).toBe('author');
    const curated = await f.json<{ work: string }>(await f.call('POST', '/v1/works', await f.catalogueBody({ language: 'en',
      profile: 'metadata-only-v1', title: 'A curated Work', actingSubject: f.actor,
    })), 201);
    expect(await queryCredits(curated.work)).toHaveLength(0);
    const proposal = await f.propose(`OL${Math.floor(Math.random() * 900000 + 100000)}W`,
      [author('/authors/OL1A')], 'An imported classic');
    const imported = await f.adoptWork(proposal);
    expect(await queryCredits(imported.work)).toHaveLength(0);
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }); }
});
