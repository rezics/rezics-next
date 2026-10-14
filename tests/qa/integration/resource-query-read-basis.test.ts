import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { DiscoveryProjection } from '../../../services/main/src/modules/discovery/store.ts';
import { MANAGE_SCOPE, MANAGE_ACTION } from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import { backfillPublicNameProjections } from '../../../services/main/src/modules/search/backfill.ts';
import { fusekiReadBudget } from '../../../services/main/src/infrastructure/fuseki.ts';
import { activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { selectMainDefault, mainSelectionDigest } from '../../../services/main/src/modules/work/select-main.ts';
import { advanceQueryPopulation } from '../../../services/main/tests/g-1053-query-fixture.ts';
import { startHomeStack } from './feed-read-support.ts';

test('resource Query re-pins a moving read basis and ignores unrelated population writes during selection', async () => {
  const home = await startHomeStack('resource-query-read-basis', { projectionStart: 'current', profileCredits: true });
  const { stack, author } = home;
  const projection = new DiscoveryProjection(stack.accessPool);
  const app = createMainApp(stack.fuseki, { ...home.deps, discovery: projection });
  const command = async <T>(path: string, body: unknown, expected = 200) => home.json<T>(await app.handle(
    new Request(`http://main.local${path}`, { method: 'POST', headers: {
      'content-type': 'application/json', authorization: `Bearer ${author.token}`,
      'idempotency-key': randomUUID(),
    }, body: JSON.stringify(body) })), expected);
  const original = stack.fuseki.query.bind(stack.fuseki);
  try {
    const phrase = `Readbasis${randomUUID().replaceAll('-', '')}`;
    const intent = { title: `${phrase} original`, language: 'en',
      semanticTypes: ['https://schema.org/Book'], authorAgent: author.actor };
    const work = await activateMetadataWork(stack.env, { ...intent,
      admission: stack.admission(author.actor, 'work:create:root', 'work.create',
        metadataWorkRequestDigest(intent.title, intent.semanticTypes, intent.language, intent)) });
    const contribution = await stack.contribution(work.work, author.actor, 'en', 'An independently published original');
    const selection = { context: { kind: 'main-version-default' as const, id: work.mainVersion },
      work: work.work, contribution: contribution.contribution, publicationDecision: contribution.decision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: author.actor };
    expect((await selectMainDefault(stack.env, stack.admission(author.actor,
      `publication:select:${work.mainVersion}`, 'publication.select', mainSelectionDigest(selection)), selection)).outcome).toBe('succeeded');
    await author.grant('space:create:root', 'space.create');
    const space = await command<{ realm: string }>('/v1/spaces', { profile: 'space-realm-v1',
      name: `${phrase} community`, capabilities: ['realm'], actingSubject: author.actor,
      initialSettings: { visibility: 'public', reviewRequired: false, reviewMode: 'open',
        whoMaySubmit: 'members', selfJoin: true, rules: [] } }, 201);
    await backfillPublicNameProjections(stack.env, stack.accessPool, 64);
    await author.grant(MANAGE_SCOPE, MANAGE_ACTION);
    let generation = await command<{ generation: string; checkpoint: string; complete: boolean }>(
      '/v1/discovery/generation-builds', { profile: 'discovery-generation-build-v1',
        actingSubject: author.actor, basis: { scope: 'global', realm: null, context: null } });
    while (!generation.complete) generation = await advanceQueryPopulation(home, projection, generation, [work.work]);
    await command('/v1/discovery/generation-activations', { profile: 'discovery-generation-activation-v1',
      actingSubject: author.actor, generation: generation.generation, expectedHeadRevision: null });

    for (const phase of ['baseline', 'opening', 'selection'] as const) {
      let moved = false;
      stack.fuseki.query = async (body, maxBytes) => {
        const answer = await original(body, maxBytes);
        if (!moved && (phase === 'opening' ? body.includes('SELECT ?epoch ?sequence WHERE')
          : phase === 'selection' && body.includes('BIND(rv:rankedText'))) {
          moved = true;
          // A real native writer moves the basis after this read's snapshot.
          // Its preparation does not consume the caller's read allocation.
          await fusekiReadBudget.run(undefined, () => stack.publicWork(author.actor, ['en'], `Unrelated ${randomUUID()}`));
        }
        return answer;
      };
      const response = await app.handle(new Request('http://main.local/v1/query', {
        method: 'POST', headers: { 'content-type': 'application/json', 'accept-language': 'en' },
        body: JSON.stringify({ profile: 'resource-list-v1', context: 'global', scope: { kind: 'all' },
          sort: 'relevance', limit: 20, q: phrase }),
      }));
      const body = await response.text();
      expect(moved, phase).toBe(phase !== 'baseline');
      expect(response.status, `${phase}: ${body}`).toBe(200);
      const page = JSON.parse(body) as { result: { items: { id: string }[] } };
      expect(page.result.items.map(item => item.id), phase).toContain(work.work);
      expect(page.result.items.map(item => item.id), phase).toContain(space.realm);
      stack.fuseki.query = original;
    }
  } finally {
    stack.fuseki.query = original;
    await home.stop();
  }
});
