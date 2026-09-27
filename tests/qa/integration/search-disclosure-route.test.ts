import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DEFAULT_MEDIA_CONTEXT } from '../../../services/main/src/modules/media/store.ts';
import { activateTextContribution, textContributionDigest }
  from '../../../services/main/src/modules/contribution/draft.ts';
import { searchRoutes, type SearchRouteDependencies }
  from '../../../services/main/src/routes/search.ts';
import { contextFixture, nativeId } from './context-fixture.ts';
import { startMediaStack } from './media-support.ts';

test('SEARCH03/SEARCH11: public route excludes a private Context before hits, score and facets', async () => {
  const f = await contextFixture(Bun.env as Record<string, string>);
  try {
    await f.grant('context:create:root', 'context.create');
    const target = nativeId();
    const visible = `public${randomUUID().replaceAll('-', '')}`;
    const secret = `private${randomUUID().replaceAll('-', '')}`;
    const makeContext = async (disclosure: 'public' | 'private', label: string) => {
      const created = await f.json<{ context: string }>(await f.call('POST', '/v1/contexts', {
        profile: 'context-v1', role: 'shared', disclosure, base: null,
        entries: [{ target, relation: 'https://rezics.com/vocab/searchDisclosureRelation',
          state: 'defined', definition: nativeId(),
          applicability: [] }], actingSubject: f.actorA,
      }), 201);
      await f.grant(`context:change:${created.context}`, 'context.preference');
      await f.json(await f.call('POST',
        `/v1/contexts/${created.context.split('/').at(-1)}/preferences`, {
          profile: 'context-preference-v1', expectedPreferenceHead: null,
          labels: [{ target, language: 'en', label }], actingSubject: f.actorA,
        }), 201);
      return created.context;
    };
    const publicContext = await makeContext('public', visible);
    const privateContext = await makeContext('private', secret);
    const input = { profile: 'public-disclosed-fields-phrase-v1',
      contexts: [publicContext, privateContext], statements: [], resources: [],
      mediaContext: DEFAULT_MEDIA_CONTEXT, language: 'en' };
    const visibleResponse = await f.call('POST', '/v1/queries', { ...input, phrase: visible },
      randomUUID(), null);
    const visibleBody = await f.json<{ complete: boolean; total: number;
      results: Array<{ owner: string; score: number }>;
      facets: { contexts: number; statements: number; names: number } }>(visibleResponse, 200);
    expect(visibleBody).toMatchObject({ complete: true, total: 1,
      facets: { contexts: 1, statements: 0, names: 0 } });
    expect(visibleBody.results).toMatchObject([{ owner: publicContext, score: 1 }]);
    const hiddenResponse = await f.call('POST', '/v1/queries', { ...input, phrase: secret },
      randomUUID(), null);
    const hiddenBody = await f.json<{ complete: boolean; total: number;
      results: unknown[]; facets: { contexts: number; statements: number; names: number } }>(
      hiddenResponse, 200);
    expect(hiddenBody).toMatchObject({ complete: true, total: 0, results: [],
      facets: { contexts: 0, statements: 0, names: 0 } });
    expect(JSON.stringify(hiddenBody)).not.toContain(secret);
    expect(JSON.stringify(hiddenBody)).not.toContain(privateContext);
  } finally { await f.close(); }
}, 120_000);

test('SEARCH03/SEARCH11: a public Work title matches while its private draft body changes no public field', async () => {
  const stack = await startMediaStack('search-fields-route');
  try {
    const member = await stack.member('search-owner');
    const publicTerm = `publictitle${randomUUID().replaceAll('-', '')}`;
    const privateTerm = `privatedraft${randomUUID().replaceAll('-', '')}`;
    const work = await stack.publicWork(member.actor, ['en'], publicTerm);
    const input = { work: work.work, language: 'en', body: privateTerm,
      actingSubject: member.actor };
    await activateTextContribution(stack.env, stack.admission(member.actor,
      `contribution:create:${work.work}`, 'contribution.create', textContributionDigest(input)), input);
    const app = searchRoutes(stack.fuseki, { environment: stack.env,
      access: stack.access, account: { verify: async () => member.principal }, media: stack.media,
      governance: { store: { restrictedTitles: async () => new Set<string>() } },
    } as unknown as SearchRouteDependencies);
    const search = async (phrase: string) => app.handle(new Request('http://main.local/v1/queries', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        profile: 'public-disclosed-fields-phrase-v1', phrase, contexts: [], statements: [],
        resources: [work.work], mediaContext: DEFAULT_MEDIA_CONTEXT, language: 'en',
      }),
    }));
    const visibleResponse = await search(publicTerm);
    expect(visibleResponse.status).toBe(200);
    const visible = await visibleResponse.json() as { total: number;
      results: Array<{ owner: string; score: number }>;
      facets: { contexts: number; statements: number; names: number } };
    expect(visible).toMatchObject({ total: 1, results: [{ owner: work.work, score: 1 }],
      facets: { contexts: 0, statements: 0, names: 1 } });
    const hiddenResponse = await search(privateTerm);
    expect(hiddenResponse.status).toBe(200);
    const hidden = await hiddenResponse.json() as { total: number; results: unknown[];
      facets: { contexts: number; statements: number; names: number } };
    expect(hidden).toMatchObject({ total: 0, results: [],
      facets: { contexts: 0, statements: 0, names: 0 } });
    expect(JSON.stringify(hidden)).not.toContain(privateTerm);
  } finally { await stack.stop(); }
}, 120_000);
