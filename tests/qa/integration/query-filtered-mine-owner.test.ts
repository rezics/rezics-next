import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { DiscoveryProjection } from '../../../services/main/src/modules/discovery/store.ts';
import { MANAGE_ACTION, MANAGE_SCOPE } from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import { AccessJudgments } from '../../../services/main/src/modules/judgment/access.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/global.ts';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';
import { startHomeStack } from './feed-read-support.ts';
import { acceptClassifiedWork, discloseConcept, shareClassifiedConcepts,
  type ClassifiedConcept } from './work-classification.ts';

interface QueryPage {
  items: { id: string }[];
  nextCursor: string | null;
}

interface QueryResponse {
  template: string;
  selection: { scope: { kind: string } };
  result: QueryPage;
}

interface Generation {
  generation: string;
  checkpoint: string;
  complete: boolean;
  state: string;
}

test('filtered Mine Query reads the signed-in member’s rated Works and binds its continuation to Mine', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the integration tier');
  const home = await startHomeStack('query-filtered-mine-owner');
  try {
    const { stack, author, reader } = home;
    await grantRecordedPlatformUse(stack.accessPool, author.principalId, ['platform-admin']);
    await grantRecordedPlatformUse(stack.accessPool, reader.principalId, ['platform-admin']);
    const app = createMainApp(stack.fuseki, { ...home.deps,
      discovery: new DiscoveryProjection(stack.accessPool), judgments: new AccessJudgments(stack.accessPool) });
    const call = (body: unknown, token?: string) => app.handle(new Request('http://main.local/v1/query', {
      method: 'POST', headers: { 'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
    }));
    const json = home.json;

    await author.grant(MANAGE_SCOPE, MANAGE_ACTION);
    await author.grant(GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
    await author.grant('classification:define:global', 'classification.proposition.define');
    await author.grant('context:create:root', 'context.create');
    await author.grant(`statement:speak:${author.actor}`, 'statement.record');
    await author.grant('classification:decide:global', 'statement.decide');

    const works = [];
    for (const index of [1, 2]) {
      works.push(await stack.publicWork(author.actor, ['en'], `Filtered Mine Work ${index} ${randomUUID()}`));
    }
    const ratingContext = await json<{ context: string }>(await home.call('POST', '/v1/global-rating-contexts', {
      profile: 'global-rating-standing-context-v1', question: 'Filtered Mine quality', actingSubject: author.actor,
    }, author.token), 201);
    await author.grant(`rating:observe:${ratingContext.context}`, 'rating.observation.set');
    for (const work of works) await json(await home.call('POST', '/v1/global-rating-observations', {
      profile: 'global-rating-standing-observation-v1', context: ratingContext.context, work: work.work,
      mainVersion: work.mainVersion, value: 5, expectedRevisionHead: null, actingSubject: author.actor,
    }, author.token), 201);

    const sendAsAuthor = (method: string, path: string, body?: unknown) => home.call(method, path, body, author.token);
    const term = await json<ClassifiedConcept>(await sendAsAuthor('POST', '/v1/classification-propositions', {
      profile: 'classification-proposition-v1', label: `Filtered Mine ${randomUUID()}`, actingSubject: author.actor,
    }), 201);
    const interpretation = await shareClassifiedConcepts(sendAsAuthor, json, author.actor, [term]);
    await discloseConcept(stack.accessPool, author.principal, author.actor, term.concept);
    for (const work of works) await acceptClassifiedWork(sendAsAuthor, json, author.actor, work, term, interpretation);

    const build = async (member: typeof author, basis: { scope: 'global' | 'mine'; realm: null; context: string | null }) => {
      let row = await json<Generation>(await home.call('POST', '/v1/discovery/generation-builds', {
        profile: 'discovery-generation-build-v1', actingSubject: member.actor, basis,
      }, member.token), 200);
      for (let steps = 0; !row.complete && steps < 20; steps++) {
        row = await json<Generation>(await home.call('POST',
          `/v1/discovery/generations/${row.generation}/advance`, {
            actingSubject: member.actor, expectedCheckpoint: row.checkpoint,
          }, member.token), 200);
      }
      expect(row).toMatchObject({ complete: true, state: 'ready' });
      const head = await json<{ activeHeadRevision: string | null }>(await home.call('GET',
        `/v1/discovery/generations/${row.generation}?actingSubject=${encodeURIComponent(member.actor)}`,
        undefined, member.token));
      await json(await home.call('POST', '/v1/discovery/generation-activations', {
        profile: 'discovery-generation-activation-v1', actingSubject: member.actor, generation: row.generation,
        expectedHeadRevision: head.activeHeadRevision,
      }, member.token), 200);
    };
    await build(author, { scope: 'global', realm: null, context: null });
    await build(author, { scope: 'mine', realm: null, context: ratingContext.context });
    await build(reader, { scope: 'mine', realm: null, context: ratingContext.context });

    const query = { profile: 'filter-document-v2', context: 'global', scope: { kind: 'mine' }, sort: 'newest',
      page: { size: 1 }, ratingContext: ratingContext.context, actingSubject: author.actor,
      filter: { all: [{ facet: 'concept', all: [term.concept] }] } };
    const firstResponse = await call(query, author.token);
    const firstText = await firstResponse.text();
    if (firstResponse.status !== 200) {
      throw new Error(`Owner filtered Mine Query expected HTTP 200; received HTTP ${firstResponse.status}: ${firstText}`);
    }
    expect(firstResponse.headers.get('cache-control')).toBe('private, no-store');
    const first = JSON.parse(firstText) as { template: string; selection: QueryResponse['selection']; result: QueryPage };
    expect(first.template).toBe('concept-works-v1');
    expect(first.selection.scope).toEqual({ kind: 'mine' });
    expect(first.result.items).toHaveLength(1);
    expect(works.map(work => work.work)).toContain(first.result.items[0]!.id);
    expect(first.result.nextCursor).toBeString();

    const nextResponse = await call({ ...query, page: { size: 1, continuation: first.result.nextCursor } }, author.token);
    const nextText = await nextResponse.text();
    if (nextResponse.status !== 200) {
      throw new Error(`Mine continuation expected HTTP 200; received HTTP ${nextResponse.status}: ${nextText}`);
    }
    const next = JSON.parse(nextText) as QueryResponse;
    expect(next.selection.scope).toEqual({ kind: 'mine' });
    expect(next.result.items.map(item => item.id)).toEqual(works.map(work => work.work)
      .filter(id => id !== first.result.items[0]!.id));

    const changedScope = await call({ ...query, scope: { kind: 'all' },
      page: { size: 1, continuation: first.result.nextCursor } }, author.token);
    const changedScopeText = await changedScope.text();
    if (![400, 409].includes(changedScope.status)) {
      throw new Error(`Mine continuation reused with scope all expected HTTP 400 or 409; received HTTP ${changedScope.status}: ${changedScopeText}`);
    }

    const otherResponse = await call(query, reader.token);
    const otherText = await otherResponse.text();
    if (otherResponse.status === 200) {
      const other = JSON.parse(otherText) as QueryResponse;
      expect(other.result.items.map(item => item.id)).not.toContain(works[0]!.work);
      expect(other.result.items.map(item => item.id)).not.toContain(works[1]!.work);
    } else if (![401, 403].includes(otherResponse.status)) {
      throw new Error(`Other member filtered Mine Query expected HTTP 200 without the owner’s Works, 401 or 403; received HTTP ${otherResponse.status}: ${otherText}`);
    }

    const anonymousResponse = await call(query);
    const anonymousText = await anonymousResponse.text();
    if (anonymousResponse.status !== 401) {
      throw new Error(`Anonymous filtered Mine Query expected HTTP 401; received HTTP ${anonymousResponse.status}: ${anonymousText}`);
    }
  } finally { await home.stop(); }
}, 180_000);
