import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { DiscoveryAudienceStore } from '../../../services/main/src/modules/discovery/audience.ts';
import { RatingPopulationsStore } from '../../../services/main/src/modules/rating/populations-access.ts';
import { SuitabilityStore } from '../../../services/main/src/modules/suitability/store.ts';
import { TargetRatingInventoryStore } from '../../../services/main/src/modules/rating/target-inventory.ts';
import {
  configureDisclosure,
  configureDisclosurePool,
  DisclosureStore,
} from '../../../services/main/src/modules/disclosure/read.ts';
import { defaultPreferences } from '../../../services/main/src/modules/feed/personal.ts';
import { DEFAULT_PERSON_CHOICES } from '../../../services/main/src/modules/preferences/store.ts';
import { GRAPHS, ID, RV, iri, lit } from '../../../services/main/src/modules/work/activate.ts';
import { deliverRealmPolicy } from '../../../services/main/src/modules/space/policy.ts';
import {
  GLOBAL_CONTEXT_SCOPE,
  GLOBAL_RATING_POPULATION_OWNER,
} from '../../../services/main/src/modules/rating/global.ts';
import type { RankingGenerations } from '../../../services/main/src/modules/recommendation/ranking.ts';
import { startHomeStack } from './feed-read-support.ts';

interface Page<Item = { id: string }> {
  items: Item[];
  complete: boolean;
  nextCursor: string | null;
  count: { value: number; kind: string };
}
interface Defined {
  scheme: string;
  schemeHead: string;
  concept: string;
  sense: string;
  definitionRevision: string;
}

test('G939: unified reads traverse large multilingual vocabulary, every owner, disclosure, preferences and rating populations', async () => {
  const started = Date.now(),
    home = await startHomeStack('g-939-discovery');
  const { stack, author, reader } = home;
  try {
    const token = `g939${randomUUID().replaceAll('-', '')}`;
    const readerAgent = await home.provision(`${token} reader`, reader.token);
    const authorAgent = await home.provision(`${token} author`, author.token);
    const audience = new DiscoveryAudienceStore(stack.accessPool);
    // Ranking candidate injection isolates section composition from generation
    // admission (covered by recommendation-generation/context). No scores or
    // new signals are manufactured by the discovery implementation.
    let rankedIds: string[] = [];
    const recommendations = {
      fencePublicCandidates: async () => {},
      publicCandidates: async (limit: number, cursor?: string) => {
        const start = cursor ? Number(cursor) : 0,
          ids = rankedIds.slice(start, start + limit);
        return {
          generation: randomUUID(),
          items: ids.map((candidate) => ({ candidate })),
          continuation: start + limit < rankedIds.length ? String(start + limit) : null,
        };
      },
    } as unknown as RankingGenerations;
    const deps = {
      ...home.deps,
      mediaAccess: stack.mediaAccess,
      discoveryAudience: audience,
      recommendations,
      ratingPopulations: new RatingPopulationsStore(stack.accessPool),
      targetRatingInventory: new TargetRatingInventoryStore(stack.accessPool),
      suitability: new SuitabilityStore(stack.accessPool, stack.access),
    };
    const app = createMainApp(stack.fuseki, deps);
    const disclosure = new DisclosureStore(stack.accessPool);
    configureDisclosurePool(stack.accessPool, disclosure);
    configureDisclosure(stack.env, disclosure);
    const call = (path: string, body?: unknown, bearer?: string, method = body ? 'POST' : 'GET') =>
      app.handle(
        new Request(`http://main.local${path}`, {
          method,
          headers: {
            'accept-language': 'en',
            ...(body
              ? { 'content-type': 'application/json', 'idempotency-key': randomUUID() }
              : {}),
            ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
    const query = async (type?: string, cursor?: string, limit = 7, q?: string) => {
      const body = {
        profile: 'resource-list-v1',
        context: 'global',
        scope: { kind: 'all' },
        sort: q ? 'relevance' : 'newest',
        limit,
        q,
        cursor,
        ...(type ? { filter: { all: [{ facet: 'type', any: [type] }] } } : {}),
      };
      return (
        await home.json<{ result: Page<{ id: string; kind: string }> }>(
          await call('/v1/query', body),
        )
      ).result;
    };
    const publicWork = await stack.publicWork(author.actor, ['en'], `${token} public`);
    const privateWork = await stack.privateWork(authorAgent, `${token} private`);
    rankedIds = [publicWork.work, privateWork.work];
    await author.grant('space:create:root', 'space.create');
    const community = await home.json<{ realm: string; space: string }>(
      await call(
        '/v1/spaces',
        {
          profile: 'space-realm-v1',
          name: `${token} community`,
          language: 'en',
          capabilities: ['realm'],
          actingSubject: author.actor,
        },
        author.token,
      ),
      201,
    );
    const hiddenCommunity = await home.json<{ realm: string; space: string }>(
      await call(
        '/v1/spaces',
        {
          profile: 'space-realm-v1',
          name: `${token} private community`,
          language: 'en',
          capabilities: ['realm'],
          actingSubject: author.actor,
        },
        author.token,
      ),
      201,
    );
    await deliverRealmPolicy(stack.env, {
      realm: hiddenCommunity.realm,
      receipt_id: randomUUID(),
      generation: '1',
      visibility: 'private',
      review_mode: 'mandatory',
    });
    const collection = ID + randomUUID();
    await home.json(
      await call(
        '/v1/collections',
        { collection, name: `${token} list`, disclosure: 'public', actingSubject: authorAgent },
        author.token,
      ),
      201,
    );
    await author.grant('classification:define:global', 'classification.proposition.define');
    const definition = {
      profile: 'classification-proposition-v2',
      scheme: null,
      labels: [
        { language: 'en', value: `${token} fiction` },
        { language: 'zh-Hant', value: '戰國小說' },
      ],
      alternativeLabels: [{ language: 'fr', value: `${token} roman` }],
      broader: [],
      narrower: [],
      actingSubject: author.actor,
    };
    const root = await home.json<Defined>(
      await call('/v1/classification-vocabulary', definition, author.token),
      201,
    );
    const child = await home.json<Defined>(
      await call(
        '/v1/classification-vocabulary',
        {
          ...definition,
          scheme: { id: root.scheme, expectedHead: root.schemeHead },
          broader: [root.concept],
          labels: [
            { language: 'en', value: `${token} urban` },
            { language: 'zh-Hans', value: '都市小说' },
          ],
          alternativeLabels: [],
        },
        author.token,
      ),
      201,
    );
    await author.grant('classification:decide:global', 'classification.decision.set');
    for (const work of [publicWork, privateWork]) {
      await home.json(
        await call(
          '/v1/classification-decisions',
          {
            profile: 'classification-direct-decision-v1',
            context: { kind: 'global' },
            work: work.work,
            mainVersion: work.mainVersion,
            sense: child.sense,
            expectedDecisionHead: null,
            outcome: 'accepted',
            actingSubject: author.actor,
          },
          author.token,
        ),
        201,
      );
    }
    // Cardinality fixture only: native vocabulary admission and multilingual
    // hierarchy above remain real commands. Bulk labels let this test falsify
    // the former 256-Concept and 2,048-label inventory ceilings in one insertion.
    const bulk = Array.from({ length: 270 }, () => ID + randomUUID());
    const zone = ID + randomUUID();
    await author.grant(`zone:edit:${zone}`, 'zone.edit');
    await home.json(
      await call(
        '/v1/zones',
        { zone, space: community.space, disclosure: 'public', actingSubject: author.actor },
        author.token,
      ),
      201,
    );
    await stack.fuseki
      .update(`PREFIX rv: <${RV}> PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
      INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
        ${bulk
          .map(
            (
              id,
              i,
            ) => `${iri(id)} a skos:Concept ; rv:conceptState rv:Active ; skos:inScheme ${iri(root.scheme)} ;
          skos:prefLabel ${['en', 'fr', 'de', 'es', 'it', 'pt', 'ja', 'zh-Hans']
            .map((language) => `${lit(`${token} topic ${i}`)}@${language}`)
            .join(', ')} .`,
          )
          .join('\n')} } }`);
    expect(Date.now() - started).toBeLessThan(600_000);
    const seen: string[] = [];
    let cursor: string | undefined, final: Page | undefined;
    for (let page = 0; page < 200; page++) {
      final = await home.json<Page>(
        await call(
          `/v1/discovery/concepts?q=${token}&limit=17${cursor ? `&cursor=${cursor}` : ''}`,
        ),
      );
      expect(final.items.length).toBeLessThanOrEqual(17);
      seen.push(...final.items.map((item) => item.id));
      if (final.complete) break;
      expect(final.nextCursor).not.toBeNull();
      cursor = final.nextCursor!;
    }
    expect(final!.complete).toBe(true);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual([root.concept, child.concept, ...bulk].sort());
    expect(final!.count).toEqual({ kind: 'exact', value: 272 });
    const chinese = await home.json<Page>(await call('/v1/discovery/concepts?q=战国&limit=20'));
    expect(chinese.items.map((item) => item.id)).toContain(root.concept);
    const french = await home.json<Page>(await call(`/v1/discovery/concepts?q=${token}%20roman`));
    expect(french.items.map((item) => item.id)).toEqual([root.concept]);
    const parent = await home.json<
      Page<{ id: string; usageCount: number; broader: { id: string }[] }>
    >(await call(`/v1/discovery/concepts?q=${token}%20urban`));
    expect(
      parent.items.find((item) => item.id === child.concept)?.broader.map((item) => item.id),
    ).toEqual([root.concept]);
    expect(parent.items.find((item) => item.id === child.concept)?.usageCount).toBe(1);

    for (const [type, expected] of [
      [`${RV}Realm`, community.realm],
      [`${RV}Zone`, zone],
      [`${RV}Agent`, readerAgent],
      [`${RV}Collection`, collection],
      ['https://schema.org/CreativeWork', publicWork.work],
    ] as const) {
      const page = await query(type, undefined, 64);
      expect(page.items.map((item) => item.id)).toContain(expected);
      expect(page.items.map((item) => item.id)).not.toContain(privateWork.work);
      expect(page.items.map((item) => item.id)).not.toContain(hiddenCommunity.realm);
    }
    const search = await query(undefined, undefined, 64, `${token} public`);
    expect(search.items.map((item) => item.id)).toEqual([publicWork.work]);
    const capabilities: string[] = [];
    let capabilityCursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await query(`${RV}Space`, capabilityCursor, 1, `${token} community`);
      capabilities.push(...result.items.map((item) => item.id));
      if (result.complete) break;
      capabilityCursor = result.nextCursor!;
    }
    expect(capabilities.sort()).toEqual([community.realm, zone].sort());
    const first = await query('http://www.w3.org/2004/02/skos/core#Concept', undefined, 3);
    expect(first.complete).toBe(false);
    await stack.catalogueWork(authorAgent, `${token} changed`);
    expect(
      (
        await call('/v1/query', {
          profile: 'resource-list-v1',
          context: 'global',
          scope: { kind: 'all' },
          sort: 'newest',
          limit: 3,
          cursor: first.nextCursor,
          filter: {
            all: [{ facet: 'type', any: ['http://www.w3.org/2004/02/skos/core#Concept'] }],
          },
        })
      ).status,
    ).toBe(409);

    await home.json(
      await call(
        '/v1/follows',
        {
          profile: 'follow-command-v1',
          actingSubject: readerAgent,
          following: true,
          expectedRevision: null,
          target: child.concept,
          kind: 'concept',
        },
        reader.token,
      ),
    );
    await home.json(
      await call(
        '/v1/follows',
        {
          profile: 'follow-command-v1',
          actingSubject: readerAgent,
          following: true,
          expectedRevision: null,
          target: community.realm,
          kind: 'realm',
        },
        reader.token,
      ),
    );
    const acting = `actingSubject=${encodeURIComponent(readerAgent)}`;
    const empty = await home.json<Page<{ id: string; followed: boolean }>>(
      await call(`/v1/discovery/concepts?limit=1&${acting}`, undefined, reader.token),
    );
    expect(empty.items[0]).toMatchObject({ id: child.concept, followed: true });
    const sections = await home.json<Page<{ id: string; page: Page }>>(
      await call(`/v1/discovery/sections?${acting}`, undefined, reader.token),
    );
    expect(sections.items.map((item) => item.id)).toEqual(['popular', 'communities', 'sites']);
    expect(
      sections.items.find((item) => item.id === 'communities')!.page.items.map((item) => item.id),
    ).not.toContain(community.realm);
    expect(
      sections.items.find((item) => item.id === 'popular')!.page.items.map((item) => item.id),
    ).toEqual([publicWork.work]);
    const japanese = await home.json<{ realm: string }>(
      await call(
        '/v1/spaces',
        {
          profile: 'space-realm-v1',
          name: `${token} 日本語`,
          language: 'ja',
          capabilities: ['realm'],
          actingSubject: author.actor,
        },
        author.token,
      ),
      201,
    );
    const preferences = await home.json<{ version: number }>(
      await call(`/v1/me/person-preferences?${acting}`, undefined, reader.token),
    );
    await home.json(
      await call(
        '/v1/me/person-preferences',
        {
          ...DEFAULT_PERSON_CHOICES,
          actingSubject: readerAgent,
          expectedVersion: preferences.version,
          contentLanguages: ['ja'],
        },
        reader.token,
        'PUT',
      ),
    );
    const languageSections = await home.json<
      Page<{ id: string; page: Page; reason: { kind: string } }>
    >(await call(`/v1/discovery/sections?${acting}`, undefined, reader.token));
    expect(languageSections.items.find((item) => item.id === 'communities')).toMatchObject({
      reason: { kind: 'communities-in-reader-languages' },
      page: { items: [{ id: japanese.realm }] },
    });
    const popularFirst = await home.json<Page<{ id: string; page: Page }>>(
      await call(
        `/v1/discovery/sections?section=popular&limit=1&${acting}`,
        undefined,
        reader.token,
      ),
    );
    const popularPage = popularFirst.items[0]!.page;
    expect(popularPage.items.map((item) => item.id)).toEqual([publicWork.work]);
    expect(popularPage.complete).toBe(false);
    const popularNext = await home.json<Page<{ id: string; page: Page }>>(
      await call(
        `/v1/discovery/sections?section=popular&limit=1&cursor=${popularPage.nextCursor}&${acting}`,
        undefined,
        reader.token,
      ),
    );
    expect(popularNext.items[0]!.page).toMatchObject({
      items: [],
      complete: true,
      count: { kind: 'exact', value: 1 },
    });
    const principal = await deps.account.verify(
      new Request('http://main.local', { headers: { authorization: `Bearer ${reader.token}` } }),
    );
    await deps.homePersonal.preferences(
      principal,
      {
        actingSubject: readerAgent,
        expectedRevision: (await deps.homePersonal.read(principal, readerAgent)).revision,
        preferences: { ...defaultPreferences, recommendations: false },
      },
      randomUUID(),
    );
    const disabled = await home.json<{ personalized: boolean }>(
      await call(`/v1/discovery/sections?${acting}`, undefined, reader.token),
    );
    expect(disabled.personalized).toBe(false);
    expect(
      (
        await call(
          `/v1/discovery/concepts?limit=1&${acting}&cursor=${empty.nextCursor}`,
          undefined,
          reader.token,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          `/v1/discovery/concepts?actingSubject=${encodeURIComponent(authorAgent)}`,
          undefined,
          reader.token,
        )
      ).status,
    ).toBe(403);

    await author.grant(`rating:context:${community.realm}`, 'rating.context.create');
    await author.grant(GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
    const realmContext = await home.json<{ context: string }>(
      await call(
        '/v1/rating-contexts',
        {
          profile: 'realm-standing-rating-context-v1',
          realm: community.realm,
          question: 'How good is it?',
          actingSubject: author.actor,
        },
        author.token,
      ),
      201,
    );
    const globalContext = await home.json<{ context: string }>(
      await call(
        '/v1/global-rating-contexts',
        {
          profile: 'global-rating-standing-context-v1',
          question: 'How good is it globally?',
          actingSubject: author.actor,
        },
        author.token,
      ),
      201,
    );
    await author.grant(`rating:observe:${realmContext.context}`, 'rating.observation.set');
    await author.grant(`rating:observe:${globalContext.context}`, 'rating.observation.set');
    const realmRating = {
      profile: 'realm-standing-rating-observation-v1',
      context: realmContext.context,
      work: publicWork.work,
      mainVersion: publicWork.mainVersion,
      expectedRevisionHead: null,
      value: 8,
      actingSubject: author.actor,
    };
    const rated = await home.json<{ observationRevision: string }>(
      await call('/v1/rating-observations', realmRating, author.token),
      201,
    );
    const globalRating = { ...realmRating, context: globalContext.context!, value: 4 };
    await home.json(
      await call(
        '/v1/global-rating-observations',
        { ...globalRating, profile: 'global-rating-standing-observation-v1' },
        author.token,
      ),
      201,
    );
    const populations = await home.json<Page<{ id: string; ratingCount: number; global: boolean }>>(
      await call(`/v1/rating-populations?target=${encodeURIComponent(publicWork.work)}`),
    );
    expect(populations.items).toHaveLength(2);
    expect(populations.items.find((item) => item.id === community.realm)).toMatchObject({
      ratingCount: 1,
      global: false,
    });
    expect(
      populations.items.find((item) => item.id === GLOBAL_RATING_POPULATION_OWNER),
    ).toMatchObject({ ratingCount: 1, global: true });
    await stack.accessPool.query(
      `INSERT INTO access.authority_subject (id,kind)
      VALUES ($1,'institution') ON CONFLICT DO NOTHING`,
      [community.realm],
    );
    await stack.accessPool.query(
      `INSERT INTO access.membership_policy
      (kind,owner_subject,revision,terms_revision) VALUES ('realm',$1,1,'g939-terms') ON CONFLICT DO NOTHING`,
      [community.realm],
    );
    await stack.accessPool.query(
      `INSERT INTO access.membership
      (id,kind,owner_subject,member_subject,state,generation,policy_revision,terms_revision,consent_reference)
      SELECT $1,'realm',$2,$3,'joined',1,revision,terms_revision,'g939-fixture'
      FROM access.membership_policy WHERE kind='realm' AND owner_subject=$2`,
      [randomUUID(), community.realm, readerAgent],
    );
    const memberPopulation = await home.json<Page<{ id: string; readerCommunity: boolean }>>(
      await call(
        `/v1/rating-populations?target=${encodeURIComponent(publicWork.work)}&${acting}`,
        undefined,
        reader.token,
      ),
    );
    expect(
      memberPopulation.items.find((item) => item.id === community.realm)?.readerCommunity,
    ).toBe(true);
    const populationFirst = await home.json<Page>(
      await call(`/v1/rating-populations?target=${encodeURIComponent(publicWork.work)}&limit=1`),
    );
    expect(populationFirst.complete).toBe(false);
    const populationNext = await home.json<Page>(
      await call(
        `/v1/rating-populations?target=${encodeURIComponent(publicWork.work)}&limit=1&cursor=${populationFirst.nextCursor}`,
      ),
    );
    expect(populationNext.complete).toBe(true);
    expect(
      [...populationFirst.items, ...populationNext.items].map((item) => item.id).sort(),
    ).toEqual([community.realm, GLOBAL_RATING_POPULATION_OWNER].sort());
    const named = await home.json<Page>(
      await call(`/v1/rating-populations?target=${encodeURIComponent(publicWork.work)}&q=${token}`),
    );
    expect(named.items.map((item) => item.id)).toEqual([community.realm]);
    const withdrawn = {
      ...realmRating,
      expectedRevisionHead: rated.observationRevision!,
      value: null,
    };
    await home.json(await call('/v1/rating-observations', withdrawn, author.token), 201);
    const remaining = await home.json<Page>(
      await call(`/v1/rating-populations?target=${encodeURIComponent(publicWork.work)}`),
    );
    expect(remaining.items.map((item) => item.id)).toEqual([GLOBAL_RATING_POPULATION_OWNER]);
    let dailyRevision: string | undefined;
    for (const cadence of ['daily', 'experience'] as const) {
      const context = await home.json<{ context: string }>(
        await call(
          '/v1/rating-contexts',
          {
            profile: `realm-${cadence}-rating-context-v1`,
            realm: community.realm,
            question: `How good is this ${cadence}?`,
            actingSubject: author.actor,
            ...(cadence === 'daily' ? { timeZone: 'UTC' } : {}),
          },
          author.token,
        ),
        201,
      );
      await author.grant(`rating:observe:${context.context}`, 'rating.observation.set');
      const cadenceRating = await home.json<{ observationRevision: string }>(
        await call(
          '/v1/rating-observations',
          {
            ...realmRating,
            context: context.context,
            profile: `realm-${cadence}-rating-observation-v1`,
            ...(cadence === 'experience' ? { occasion: randomUUID() } : {}),
          },
          author.token,
        ),
        201,
      );
      if (cadence === 'daily') dailyRevision = cadenceRating.observationRevision;
    }
    const cadencePopulations = await home.json<Page<{ id: string; ratingCount: number }>>(
      await call(`/v1/rating-populations?target=${encodeURIComponent(publicWork.work)}`),
    );
    expect(cadencePopulations.items.map((item) => [item.id, item.ratingCount])).toEqual([
      [community.realm, 2],
      [GLOBAL_RATING_POPULATION_OWNER, 1],
    ]);
    await author.grant('semantic:create:root', 'semantic.change');
    await author.grant(`work:read:${publicWork.work}`, 'work.read');
    const target = (
      await home.json<{ component: string }>(
        await call(
          '/v1/semantic/changes',
          {
            profile: 'semantic-change-v1',
            expectedHead: null,
            actingSubject: author.actor,
            state: {
              component: 'resource',
              types: [`${RV}Character`],
              properties: [
                {
                  predicate: 'https://schema.org/name',
                  value: {
                    kind: 'language-string',
                    lexical: `${token} character`,
                    language: 'en',
                    direction: 'ltr',
                  },
                },
                {
                  predicate: `${RV}semanticWork`,
                  value: { kind: 'resource', ref: publicWork.work },
                },
              ],
            },
          },
          author.token,
        ),
        201,
      )
    ).component;
    const targetContext = await home.json<{ context: string }>(
      await call(
        '/v1/rating-contexts',
        {
          profile: 'realm-target-rating-context-v2',
          realm: community.realm,
          question: 'How good is this Character?',
          language: 'en',
          targetGrain: 'resource',
          actingSubject: author.actor,
        },
        author.token,
      ),
      201,
    );
    await author.grant(`rating:observe:${targetContext.context}`, 'rating.observation.set');
    await home.json(
      await call(
        '/v1/rating-observations',
        {
          profile: 'realm-target-rating-observation-v1',
          context: targetContext.context,
          target,
          expectedRevisionHead: null,
          value: 7,
          actingSubject: author.actor,
        },
        author.token,
      ),
      201,
    );
    const targetPopulations = await home.json<Page<{ id: string; ratingCount: number }>>(
      await call(`/v1/rating-populations?target=${encodeURIComponent(target)}`),
    );
    expect(targetPopulations.items.map((item) => [item.id, item.ratingCount])).toEqual([
      [community.realm, 1],
    ]);
    // Native evidence tampering must fail closed, including when it turns a
    // whole Context's apparent count into zero before owner verification.
    const availability = async (remove: string, add: string) =>
      stack.fuseki.update(`PREFIX rv: <${RV}>
      DELETE DATA { GRAPH ${iri(GRAPHS.revisions)} { ${iri(dailyRevision!)} rv:ratingAvailability rv:${remove} } };
      INSERT DATA { GRAPH ${iri(GRAPHS.revisions)} { ${iri(dailyRevision!)} rv:ratingAvailability rv:${add} } }`);
    await availability('Available', 'Withdrawn');
    expect(
      (await call(`/v1/rating-populations?target=${encodeURIComponent(publicWork.work)}`)).status,
    ).toBe(503);
    await availability('Withdrawn', 'Available');
    // Suitability is Access state: no graph mutation or graph cursor movement
    // can be relied on to keep aggregate Concept usage from leaking it.
    await author.grant(`work:edit:${publicWork.work}`, 'work.edit');
    await home.json(
      await call(
        `/v1/suitability/${publicWork.work.slice(-36)}`,
        {
          actingSubject: author.actor,
          expectedRevision: null,
          labels: ['r18'],
          basis: 'author',
        },
        author.token,
        'PUT',
      ),
    );
    const restricted = await home.json<Page<{ id: string; usageCount: number }>>(
      await call(`/v1/discovery/concepts?q=${token}%20urban`),
    );
    expect(restricted.items.find((item) => item.id === child.concept)?.usageCount).toBe(0);
    expect((await query(undefined, undefined, 64, `${token} public`)).items).toEqual([]);
  } finally {
    await home.stop();
  }
}, 600_000);
