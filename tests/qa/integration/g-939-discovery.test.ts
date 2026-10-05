import { expect, test } from 'bun:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { backfillPublicNameProjections } from '../../../services/main/src/modules/search/backfill.ts';
import { backfillPublicNames } from '../../../services/main/src/modules/search/names.ts';
import { PUBLIC_SEARCH_GRAPH } from '../../../services/main/src/modules/work/select-main.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { DiscoveryProjection } from '../../../services/main/src/modules/discovery/store.ts';
import {
  MANAGE_SCOPE,
  MANAGE_ACTION,
} from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import { DiscoveryAudienceStore } from '../../../services/main/src/modules/discovery/audience.ts';
import { SuitabilityStore } from '../../../services/main/src/modules/suitability/store.ts';
import { TargetRatingInventoryStore } from '../../../services/main/src/modules/rating/target-inventory.ts';
import {
  configureDisclosure,
  configureDisclosurePool,
  DisclosureStore,
} from '../../../services/main/src/modules/disclosure/read.ts';
import { defaultPreferences } from '../../../services/main/src/modules/feed/personal.ts';
import {
  namePreferencesProjection,
  nameListingProjection,
  configureNamePreferences,
} from '../../../services/main/src/modules/search/name-preferences.ts';
import {
  PersonPreferencesStore,
  DEFAULT_PERSON_CHOICES,
} from '../../../services/main/src/modules/preferences/store.ts';
import { ID, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { deliverRealmPolicy } from '../../../services/main/src/modules/space/policy.ts';
import {
  GLOBAL_CONTEXT_SCOPE,
  GLOBAL_RATING_POPULATION_OWNER,
} from '../../../services/main/src/modules/rating/global.ts';
import {
  RankingGenerations,
  RANKING_PROFILE,
} from '../../../services/main/src/modules/recommendation/ranking.ts';
import { startHomeStack } from './feed-read-support.ts';
import { waitForRealmDirectory } from './support/realm-directory.ts';

interface Page<Item = { id: string }> {
  items: Item[];
  complete: boolean;
  nextCursor: string | null;
  stale: boolean;
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
      page: async (
        _viewer: unknown,
        _basis: unknown,
        limit: number,
        cursor?: string,
        topics?: { generation: string; concepts: string[] },
      ) => {
        const scoped = topics
          ? (
              await stack.accessPool.query<{ work: string }>(
                `SELECT DISTINCT e.work
          FROM access.discovery_entry e JOIN access.discovery_term_count t
            ON t.generation_id=e.generation_id AND t.term=e.term
          WHERE e.generation_id=$1 AND e.work_type='' AND t.concept=ANY($2::text[])`,
                [topics.generation, topics.concepts],
              )
            ).rows.map((row) => row.work)
          : rankedIds;
        const candidates = rankedIds.filter((id) => scoped.includes(id));
        const start = cursor ? Number(cursor) : 0,
          ids = candidates.slice(start, start + limit);
        return {
          generation: randomUUID(),
          items: ids.map((candidate) => ({ candidate })),
          continuation: start + limit < candidates.length ? String(start + limit) : null,
        };
      },
    } as unknown as RankingGenerations;
    await configureNamePreferences(stack.env, stack.accessPool);
    const deps = {
      ...home.deps,
      personPreferences: new PersonPreferencesStore(
        stack.accessPool,
        namePreferencesProjection(stack.env),
      ),
      mediaAccess: stack.mediaAccess,
      discoveryAudience: audience,
      recommendations,
      discovery: new DiscoveryProjection(stack.accessPool),
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
    const distractors = [];
    for (let i = 0; i < 8; i++)
      distractors.push(
        (await stack.catalogueWork(authorAgent, `${token} topic distractor ${i}`)).work,
      );
    rankedIds = [...distractors, publicWork.work, privateWork.work];
    // Shared shards retain earlier catalogues. Preparation must traverse more
    // than 30 candidates even when this file runs alone.
    for (let i = 0; i < 32; i++)
      await stack.catalogueWork(authorAgent, `G-993 background ${randomUUID()}`);
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
    const hiddenZone = ID + randomUUID();
    await author.grant(`zone:edit:${hiddenZone}`, 'zone.edit');
    await home.json(
      await call(
        '/v1/zones',
        {
          zone: hiddenZone,
          space: hiddenCommunity.space,
          disclosure: 'public',
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
    // Every Concept uses the public owner command, including the large fixture.
    const bulk: string[] = [];
    for (let i = 0; i < 270; i++) {
      const item = await home.json<Defined>(
        await call(
          '/v1/classification-vocabulary',
          {
            ...definition,
            scheme: null,
            broader: [],
            narrower: [],
            alternativeLabels: [],
            labels: ['en', 'fr', 'de', 'es', 'it', 'pt', 'ja', 'zh-Hans'].map((language) => ({
              language,
              value: `${token} topic ${i}`,
            })),
          },
          author.token,
        ),
        201,
      );
      bulk.push(item.concept);
    }
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
    expect(
      (
        await stack.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit rv:resource ?resource ; rv:publicTitle ?name .
        VALUES ?resource { ${iri(hiddenCommunity.realm)} ${iri(hiddenZone)} ${iri(privateWork.work)} } }
    }`)
      ).boolean,
    ).toBe(false);
    expect(await backfillPublicNames(stack.env)).toBeGreaterThan(272);
    expect(
      (
        await stack.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit rv:resource ?resource ; rv:publicTitle ?name .
        VALUES ?resource { ${iri(hiddenCommunity.realm)} ${iri(hiddenZone)} ${iri(privateWork.work)} } }
    }`)
      ).boolean,
    ).toBe(false);
    // Thousands of Concept alias documents share publicTitle, but must never
    // consume the existing Work collector's candidate bound or continuation.
    const workSearch = await home.json<{
      results: { work: string }[];
      stale: boolean;
      count: { value: number; precision: string };
      next: string | null;
    }>(await call(`/v1/search/catalogue?q=${token}&limit=64`));
    expect(workSearch.results.map((item) => item.work)).toEqual([publicWork.work]);
    expect(workSearch.count).toEqual({ value: 1, precision: 'exact' });
    expect(workSearch.next).toBeNull();
    await author.grant(MANAGE_SCOPE, MANAGE_ACTION);
    const refresh = async () => {
      let row = await home.json<{
        generation: string;
        checkpoint: string;
        complete: boolean;
        state: string;
      }>(
        await call(
          '/v1/discovery/generation-builds',
          {
            profile: 'discovery-generation-build-v1',
            actingSubject: author.actor,
            basis: { scope: 'global', realm: null, context: null },
          },
          author.token,
        ),
      );
      // Discovery builds resume over the whole pinned population, not a fixed
      // number of steps. Keep the preparation and harness wall-time budgets.
      while (!row.complete) {
        const checkpoint = row.checkpoint;
        row = await home.json(
          await call(
            `/v1/discovery/generations/${row.generation}/advance`,
            { actingSubject: author.actor, expectedCheckpoint: row.checkpoint },
            author.token,
          ),
        );
        expect(row.complete || row.checkpoint !== checkpoint).toBe(true);
      }
      expect(row.complete).toBe(true);
      const head = await home.json<{ activeHeadRevision: string | null }>(
        await call(
          `/v1/discovery/generations/${row.generation}?actingSubject=${encodeURIComponent(author.actor)}`,
          undefined,
          author.token,
        ),
      );
      await home.json(
        await call(
          '/v1/discovery/generation-activations',
          {
            profile: 'discovery-generation-activation-v1',
            actingSubject: author.actor,
            generation: row.generation,
            expectedHeadRevision: head.activeHeadRevision,
          },
          author.token,
        ),
      );
      return row.generation;
    };
    const discoveryGeneration = await refresh();
    await waitForRealmDirectory(stack.env, () => call(`/v1/realms?q=${token}`),
      page => page.items.some(item => item.id === community.realm));
    // Real Access ranking drives its zero-score tail from the topic projection.
    // A global candidate source is forbidden, so sparse topics cannot disappear
    // behind a large global window. Concepts themselves were created by the API.
    const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
    try {
      const ranking = new RankingGenerations({
        access: stack.accessPool,
        relay,
        dataEpoch: stack.env.lineage.dataEpoch,
        cursorKey: randomBytes(32),
        canReadWork: async () => {
          throw new Error('Public viewer uses graph disclosure');
        },
        zeroSnapshot: async () => 'fixture',
        zeroCandidates: async () => {
          throw new Error('Topic page must not scan global Works');
        },
      });
      const basis = {
        profile: RANKING_PROFILE,
        population: { kind: 'public' as const },
        candidateGrain: 'work' as const,
        semantic: null,
      };
      const manager = { principal: author.principal, actingSubject: author.actor };
      const receipt = () => ({ idempotencyKey: randomUUID(), requestDigest: '0'.repeat(64) });
      const generation = (await ranking.registerBuild(manager, basis, 1, receipt())).generation;
      const epoch = await ranking.claim(generation);
      for (let step = 0; step < 20; step++)
        if (!(await ranking.runBatch(generation, epoch)).relayBatches) break;
      expect((await ranking.finish(generation, epoch)).state).toBe('ready');
      await ranking.activate(manager, generation, null, receipt());
      expect(
        (
          await ranking.page(
            { public: true, principal: null, actingSubject: null },
            basis,
            6,
            undefined,
            { generation: discoveryGeneration, concepts: [child.concept] },
          )
        ).items,
      ).toEqual([{ candidate: publicWork.work }]);
    } finally {
      await relay.end();
    }
    expect(Date.now() - started).toBeLessThan(600_000);
    const seen: string[] = [];
    let cursor: string | undefined, final: Page | undefined;
    for (let page = 0; page < 200; page++) {
      final = await home.json<Page>(
        await call(
          `/v1/discovery/concepts?q=${token}&limit=17${cursor ? `&cursor=${cursor}` : ''}`,
        ),
      );
      expect(final.items.length).toBe(final.complete ? 272 % 17 || 17 : 17);
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
      const page = await query(type, undefined, 64, token);
      expect(page.items.map((item) => item.id)).toContain(expected);
      expect(page.items.map((item) => item.id)).not.toContain(privateWork.work);
      expect(page.items.map((item) => item.id)).not.toContain(hiddenCommunity.realm);
    }
    const listingPath = `/v1/agents/${readerAgent.slice(-36)}/listing`;
    const command = stack.fuseki.commandWithReceipt.bind(stack.fuseki);
    stack.fuseki.commandWithReceipt = async () => {
      throw new Error('Interrupted name delivery');
    };
    try {
      expect(
        (await call(listingPath, { listing: 'unlisted', expectedVersion: 0 }, reader.token, 'PUT'))
          .status,
      ).toBe(503);
    } finally {
      stack.fuseki.commandWithReceipt = command;
    }
    expect((await deps.profiles!.listing.read(readerAgent)).listing).toBe('listed');

    const unlisted = await home.json<{ version: number }>(
      await call(listingPath, { listing: 'unlisted', expectedVersion: 0 }, reader.token, 'PUT'),
    );
    expect((await query(`${RV}Agent`, undefined, 64, `${token} reader`)).items).toEqual([]);
    expect(
      (
        await stack.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
      ?unit rv:resource ${iri(readerAgent)} ; rv:publicTitle ?name } }`)
      ).boolean,
    ).toBe(false);
    // An old listed policy delivery cannot reverse a later unlisted setting.
    await nameListingProjection(stack.env)(readerAgent, 'listed', 0);
    expect((await query(`${RV}Agent`, undefined, 64, `${token} reader`)).items).toEqual([]);
    await home.json(
      await call(
        listingPath,
        { listing: 'listed', expectedVersion: unlisted.version },
        reader.token,
        'PUT',
      ),
    );
    expect(
      (await query(`${RV}Agent`, undefined, 64, `${token} reader`)).items.map((item) => item.id),
    ).toEqual([readerAgent]);
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
    // Earlier files can contribute used Concepts to this global page. The
    // fixture's own usage is checked above; this probe fences its cursor.
    expect(first.items).toHaveLength(3);
    expect(first.items.every(item => item.kind === 'concept')).toBe(true);
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
    await refresh();
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
    const hideProfile = await home.json<{ version: number }>(
      await call(
        '/v1/me/person-preferences',
        {
          ...DEFAULT_PERSON_CHOICES,
          profileVisibility: 'private',
          contentLanguages: ['ja'],
          actingSubject: readerAgent,
          expectedVersion: preferences.version + 1,
        },
        reader.token,
        'PUT',
      ),
    );
    expect(
      (
        await stack.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
      ?unit rv:resource ${iri(readerAgent)} ; rv:publicTitle ?name } }`)
      ).boolean,
    ).toBe(false);
    await namePreferencesProjection(stack.env)(readerAgent, 'public', 0);
    await refresh();
    expect(await query(`${RV}Agent`, undefined, 7, `${token} reader`)).toMatchObject({
      items: [],
      complete: true,
      nextCursor: null,
    });
    await home.json(
      await call(
        '/v1/me/person-preferences',
        {
          ...DEFAULT_PERSON_CHOICES,
          contentLanguages: ['ja'],
          actingSubject: readerAgent,
          expectedVersion: hideProfile.version,
        },
        reader.token,
        'PUT',
      ),
    );
    await refresh();
    await waitForRealmDirectory(stack.env, () => call(`/v1/realms?q=${token}`),
      page => page.items.some(item => item.id === japanese.realm));
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
    // Refill and lookahead consume the private tail, so a full final page is complete.
    expect(popularPage).toMatchObject({
      complete: true,
      nextCursor: null,
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
    await refresh();
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
    expect(memberPopulation.items[0]!.id).toBe(community.realm);
    const joinedFirst = await home.json<Page>(
      await call(
        `/v1/rating-populations?target=${encodeURIComponent(publicWork.work)}&limit=1&${acting}`,
        undefined,
        reader.token,
      ),
    );
    expect(joinedFirst.items.map((item) => item.id)).toEqual([community.realm]);
    expect(joinedFirst.complete).toBe(false);
    const joinedNext = await home.json<Page>(
      await call(
        `/v1/rating-populations?target=${encodeURIComponent(publicWork.work)}&limit=1&${acting}&cursor=${joinedFirst.nextCursor}`,
        undefined,
        reader.token,
      ),
    );
    expect(joinedNext.items.map((item) => item.id)).toEqual([GLOBAL_RATING_POPULATION_OWNER]);
    expect(joinedNext.complete).toBe(true);
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
    let experienceContext = '';
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
      await home.json<{ observationRevision: string }>(
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
      if (cadence === 'experience') experienceContext = context.context;
    }
    const cadencePopulations = await home.json<Page<{ id: string; ratingCount: number }>>(
      await call(`/v1/rating-populations?target=${encodeURIComponent(publicWork.work)}`),
    );
    expect(cadencePopulations.items.map((item) => [item.id, item.ratingCount])).toEqual([
      [community.realm, 2],
      [GLOBAL_RATING_POPULATION_OWNER, 1],
    ]);
    // A population read is an aggregate, not a replay of a bounded vote inventory.
    for (let vote = 0; vote < 1001; vote++)
      await home.json(
        await call(
          '/v1/rating-observations',
          {
            ...realmRating,
            context: experienceContext,
            profile: 'realm-experience-rating-observation-v1',
            occasion: randomUUID(),
          },
          author.token,
        ),
        201,
      );
    const manyRatings = await home.json<Page<{ id: string; ratingCount: number }>>(
      await call(`/v1/rating-populations?target=${encodeURIComponent(publicWork.work)}`),
    );
    expect(manyRatings.items.map((item) => [item.id, item.ratingCount])).toEqual([
      [community.realm, 1003],
      [GLOBAL_RATING_POPULATION_OWNER, 1],
    ]);
    expect(manyRatings.stale).toBe(false);
    const firstBackfill = await backfillPublicNameProjections(stack.env, stack.accessPool, 1);
    expect(firstBackfill.complete).toBe(false);
    expect((await backfillPublicNameProjections(stack.env, stack.accessPool, 64)).complete).toBe(
      true,
    );
    const replayedCounts = await home.json<Page<{ id: string; ratingCount: number }>>(
      await call(`/v1/rating-populations?target=${encodeURIComponent(publicWork.work)}`),
    );
    expect(replayedCounts.items).toEqual(manyRatings.items);
    // Link-only community remains readable but is absent from every public inventory.
    await deliverRealmPolicy(stack.env, {
      realm: community.realm,
      receipt_id: randomUUID(),
      generation: '1',
      visibility: 'public',
      review_mode: 'mandatory',
      listing: 'unlisted',
    });
    for (const type of [`${RV}Space`, `${RV}Realm`, `${RV}Zone`]) {
      const page = await query(type, undefined, 64, `${token} community`);
      expect(page.items.map((item) => item.id)).not.toContain(community.realm);
      expect(page.items.map((item) => item.id)).not.toContain(zone);
    }
    expect(
      (
        await stack.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
      ?unit rv:resource ?resource ; rv:publicTitle ?name . VALUES ?resource { ${iri(community.realm)} ${iri(zone)} } } }`)
      ).boolean,
    ).toBe(false);
    expect(
      (
        await home.json<Page>(
          await call(`/v1/rating-populations?target=${encodeURIComponent(publicWork.work)}`),
        )
      ).items.map((item) => item.id),
    ).toEqual([GLOBAL_RATING_POPULATION_OWNER]);
    await deliverRealmPolicy(stack.env, {
      realm: community.realm,
      receipt_id: randomUUID(),
      generation: '2',
      visibility: 'public',
      review_mode: 'mandatory',
      listing: 'listed',
    });

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
    await deps.homePersonal.preferences(
      principal,
      {
        actingSubject: readerAgent,
        expectedRevision: (await deps.homePersonal.read(principal, readerAgent)).revision,
        preferences: { ...defaultPreferences, recommendations: true },
      },
      randomUUID(),
    );
    await refresh();
    await home.json(
      await call(
        '/v1/spaces',
        {
          profile: 'space-realm-v1',
          name: `${token} lag`,
          language: 'en',
          capabilities: ['realm'],
          actingSubject: author.actor,
        },
        author.token,
      ),
      201,
    );
    const pinnedConcepts = await home.json<Page<{ id: string; usageCount: number }>>(
      await call(`/v1/discovery/concepts?q=${token}%20urban`),
    );
    expect(pinnedConcepts.stale).toBe(true);
    expect(pinnedConcepts.items.find((item) => item.id === child.concept)?.usageCount).toBe(1);
    const filteredLag = await home.json<{ result: Page }>(
      await call('/v1/query', {
        profile: 'resource-list-v1',
        context: 'global',
        scope: { kind: 'all' },
        sort: 'newest',
        limit: 64,
        filter: { all: [{ facet: 'concept', any: [child.concept] }] },
      }),
    );
    expect(filteredLag.result.stale).toBe(true);
    expect(filteredLag.result.items.map((item) => item.id)).toContain(publicWork.work);
    const followedLag = await home.json<Page<{ id: string; page: Page }>>(
      await call(`/v1/discovery/sections?section=popular&${acting}`, undefined, reader.token),
    );
    expect(followedLag.stale).toBe(true);
    expect(followedLag.items[0]!.page.items.map((item) => item.id)).toEqual([publicWork.work]);
    // Access suitability also makes the projection stale. Retain its values
    // until a fresh generation replaces them.
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
    const lagging = await home.json<Page<{ id: string; usageCount: number }> & { stale: boolean }>(
      await call(`/v1/discovery/concepts?q=${token}%20urban`),
    );
    expect(lagging.stale).toBe(true);
    expect(lagging.items.find((item) => item.id === child.concept)?.usageCount).toBe(1);
    const laggingResources = await query(undefined, undefined, 64, `${token} public`);
    expect(laggingResources.items.map((item) => item.id)).toEqual([publicWork.work]);
    expect(laggingResources.stale).toBe(true);
    // Isolated Access fixture: historical restrictions on unrelated identities
    // must not become a global inventory limit on a bounded Concept page.
    const restrictedIds = Array.from({ length: 5000 }, () => ({
      id: randomUUID(),
      target: ID + randomUUID(),
    }));
    await stack.accessPool.query(
      `INSERT INTO access.suitability_assessment
      (id,target,labels,basis,assessor,principal_id,revision_number,authority_proof,idempotency_key,request_digest)
      SELECT fixture.id::uuid,fixture.target,source.labels,source.basis,source.assessor,source.principal_id,
        1,source.authority_proof,fixture.id,source.request_digest
      FROM jsonb_to_recordset($1::jsonb) fixture(id text,target text)
      CROSS JOIN access.suitability_assessment source WHERE source.target=$2`,
      [JSON.stringify(restrictedIds), publicWork.work],
    );
    await refresh();
    const restricted = await home.json<Page<{ id: string; usageCount: number }>>(
      await call(`/v1/discovery/concepts?q=${token}%20urban`),
    );
    expect(restricted.items.find((item) => item.id === child.concept)?.usageCount).toBe(1);
    expect(
      (await query(undefined, undefined, 64, `${token} public`)).items.map((item) => item.id),
    ).toEqual([publicWork.work]);
  } finally {
    await home.stop();
  }
}, 600_000);
