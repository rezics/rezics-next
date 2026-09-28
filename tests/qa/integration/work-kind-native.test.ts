import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createMainApp } from '../../../services/main/src/app.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { authorCreditFixture } from '../fixtures/author-credit.ts';

test('G318: native creation admits package, mod, Hub, recipe and media Works with typed graph identities', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const fixture = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `work-kind-${randomUUID()}`));
  const app = createMainApp(fixture.env.fuseki, { environment: fixture.env,
    account: fixture.account.verifier, access: fixture.access });
  const call = (types: string[], key = randomUUID()) => app.handle(new Request('http://main.local/v1/works', {
    method: 'POST', headers: { authorization: `Bearer ${fixture.account.tokenA}`,
      'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ profile: 'metadata-only-v1', language: 'en', title: `Native ${[...types].sort().join(' + ')}`,
      semanticTypes: types, actingSubject: fixture.actor }),
  }));
  const types = [
    ['https://schema.org/SoftwareSourceCode'],
    ['https://schema.org/SoftwareApplication', 'https://rezics.com/vocab/ModPackage'],
    ['https://rezics.com/vocab/SkillPackage'],
    ['https://rezics.com/vocab/PromptTemplate'],
    ['https://schema.org/Recipe'],
    ['https://schema.org/Movie'],
    ['https://schema.org/TVSeries'],
    ['https://schema.org/VideoObject'],
    ['https://schema.org/MusicAlbum'],
  ];
  try {
    for (const semanticTypes of types) {
      const key = randomUUID();
      const response = await call(semanticTypes, key);
      expect(response.status).toBe(201);
      const created = await response.json() as { work: string; mainVersion: string; replayed: boolean };
      expect(created.replayed).toBe(false);
      const graph = await fixture.env.fuseki.query(`ASK { GRAPH ${iri(GRAPHS.current)} {
        ${iri(created.work)} a <https://schema.org/CreativeWork>, ${semanticTypes.map(type => `<${type}>`).join(', ')} ;
          <https://rezics.com/vocab/mainVersion> ${iri(created.mainVersion)} . } }`);
      expect(graph.boolean).toBe(true);
      const replay = await call([...semanticTypes].reverse(), key);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ work: created.work, replayed: true });
    }
    expect((await call(['https://rezics.com/vocab/AccessGrant'])).status).toBe(400);
    expect((await call(['https://schema.org/Book', 'https://schema.org/Book'])).status).toBe(400);
    expect((await call(['https://schema.org/Book', 'https://schema.org/Movie'])).status).toBe(400);
    expect((await call(['https://rezics.com/vocab/SkillPackage',
      'https://rezics.com/vocab/PromptTemplate'])).status).toBe(400);
  } finally { await fixture.close(); }
}, 180_000);
