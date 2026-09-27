import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/global.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';

async function json(response: Response, status = 200): Promise<Record<string, any>> {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body);
}

test('search cards use public native credit names and sealed standing ratings; hidden names and restricted titles do not match', async () => {
  const stack = await startMediaStack('search-card-fields');
  try {
    const actor = await stack.member('card-author');
    let restricted = new Set<string>();
    const deps = { environment: stack.env, access: stack.access,
      account: { verify: async () => actor.principal }, profiles: new ProfilesAccess(stack.accessPool),
      agentProvisioning: new AgentProvisioning(stack.accessPool, stack.env) };
    const app = createMainApp(stack.fuseki, deps);
    const call = (path: string, body?: unknown) => app.handle(new Request(`http://main.local${path}`, {
      method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json',
        'idempotency-key': randomUUID(), authorization: 'Bearer author' } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    const agent = await json(await call('/v1/agents', { profile: 'agent-provision-v1',
      displayName: 'Natsume 夏目漱石', kind: 'person' }), 201);
    const work = await stack.publicWork(actor.actor, ['en'], 'A searchable card');
    const head = await json(await call(`/v1/works/${work.work.slice(-36)}`));
    await actor.grant(`work:edit:${work.work}`, 'work.edit');
    await json(await call(`/v1/works/${work.work.slice(-36)}/agent-credits`, {
      profile: 'native-agent-credit-v1', credit: `https://rezics.com/id/${randomUUID()}`,
      agent: agent.agent, role: 'author', expectedWorkHead: head.revision, actingSubject: actor.actor,
    }), 201);
    // Search is public; bearer presentation is a separate operation.
    const search = async (phrase: string) => json(await app.handle(new Request('http://main.local/v1/queries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'public-main-phrase-v1', phrase, language: null }),
    })));
    expect((await search('夏目')).results).toMatchObject([{ work: work.work, matchedField: 'credit',
      primaryCredits: [{ participantKind: 'agent', displayName: 'Natsume 夏目漱石' }] }]);
    expect((await json(await call('/v1/search/typeahead?prefix=Nat'))).items)
      .toMatchObject([{ work: work.work, matchedField: 'credit' }]);
    await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(agent.agent)} rv:profileDisclosure ?old } } INSERT { GRAPH ${iri(GRAPHS.current)} {
      ${iri(agent.agent)} rv:profileDisclosure rv:Private } } WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(agent.agent)} rv:profileDisclosure ?old } }`);
    expect((await search('夏目')).total).toBe(0);
    expect((await json(await call('/v1/search/typeahead?prefix=Nat'))).items).toEqual([]);

    await actor.grant(GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
    const context = await json(await actor.send('POST', '/v1/global-rating-contexts', {
      profile: 'global-rating-standing-context-v1', question: 'Quality?', actingSubject: actor.actor,
    }), 201);
    await actor.grant(`rating:observe:${context.context}`, 'rating.observation.set');
    const observed = await json(await actor.send('POST', '/v1/global-rating-observations', {
      profile: 'global-rating-standing-observation-v1', context: context.context,
      work: work.work, mainVersion: work.mainVersion, value: 4, expectedRevisionHead: null,
      actingSubject: actor.actor,
    }), 201);
    expect((await search('searchable')).results).toMatchObject([{ work: work.work,
      ratingStatus: 'available', rating: { context: context.context, count: 1, mean: 4, sum: 4 }, primaryCredits: [] }]);
    await json(await actor.send('POST', '/v1/global-rating-observations', {
      profile: 'global-rating-standing-observation-v1', context: context.context,
      work: work.work, mainVersion: work.mainVersion, value: null, expectedRevisionHead: observed.observationRevision,
      actingSubject: actor.actor,
    }), 201);
    expect((await search('searchable')).results).toMatchObject([{ rating: null, ratingStatus: 'unrated' }]);
    await json(await actor.send('POST', '/v1/global-rating-contexts', {
      profile: 'global-rating-standing-context-v1', question: 'A different question?', actingSubject: actor.actor,
    }), 201);
    expect((await search('searchable')).results).toMatchObject([{ rating: null, ratingStatus: 'context-required' }]);

    const restrictedApp = createMainApp(stack.fuseki, { ...deps, governance: { store: {
      restrictedTitles: async () => restricted,
    } } } as unknown as Parameters<typeof createMainApp>[1]);
    restricted = new Set([work.work]);
    const response = await restrictedApp.handle(new Request('http://main.local/v1/queries/page', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'public-main-phrase-page-v1', phrase: 'searchable', language: null, pageSize: 20 }),
    }));
    expect((await json(response)).total).toBe(0);
    expect((await json(await restrictedApp.handle(new Request('http://main.local/v1/search/typeahead?prefix=search')))).items
      .some((item: { work: string }) => item.work === work.work)).toBe(false);
  } finally { await stack.stop(); }
}, 90_000);
