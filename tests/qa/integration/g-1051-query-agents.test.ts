import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  startTelemetry,
  flushTelemetryTraces,
  shutdownTelemetry,
} from '@rezics/observability/runtime';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';
import { assertWorkCost, profileRequest, startWorkProfileSink } from '../support/work-profile.ts';
import type { ResourceCard } from '../../../services/main/src/modules/query/resource-contract.ts';
import { queryProfileProcess } from '../../../services/main/tests/g-1053-profile-process.ts';

test('G1051: Agent Query batches public policy at 1, 16 and 64 cards and fences revocation and recovery', async () => {
  if (Bun.env.G1053_QUERY_CHILD !== 'g-1051-query-agents.test.ts')
    return queryProfileProcess('g-1051-query-agents.test.ts');
  const sink = startWorkProfileSink({ settleMs: 25 });
  startTelemetry('g-1051-query', { ...process.env, ...sink.env, OTEL_TRACES_SAMPLER_ARG: '0' });
  const { Elysia } = await import('elysia');
  const { httpTelemetry } = await import('@rezics/observability/elysia');
  const { startQueryHome, advanceQueryPopulation } =
    await import('../../../services/main/tests/g-1053-query-fixture.ts');
  const { captureSql } = await import('./g-1051-sql-profile.ts');
  const { publicWorkRead } =
    await import('../../../services/main/src/modules/work/read-session.ts');
  const { resourceCards } = await import('../../../services/main/src/modules/query/resources.ts');
  const { configureDisclosure, DisclosureStore } =
    await import('../../../services/main/src/modules/disclosure/read.ts');
  const { DiscoveryProjection } =
    await import('../../../services/main/src/modules/discovery/store.ts');
  const { MANAGE_SCOPE, MANAGE_ACTION } =
    await import('../../../services/main/src/modules/recommendation/derived-generation.ts');
  const { createMainApp } = await import('../../../services/main/src/app.ts');
  const { backfillPublicNames } =
    await import('../../../services/main/src/modules/search/names.ts');
  const home = await startQueryHome('g-1051-query');
  const { stack, author } = home;
  const discovery = new DiscoveryProjection(stack.accessPool);
  const deps = { ...home.deps, discovery };
  const app = createMainApp(stack.fuseki, deps);
  configureDisclosure(stack.env, new DisclosureStore(stack.accessPool));
  const baseline = Bun.env.G1051_BASELINE === '1';
  const marker = `g1051${randomUUID().replaceAll('-', '')}`;
  const agents: string[] = [];
  const evidence: Record<string, unknown>[] = [];
  let selected: string[] = [];
  let selectedWorks: string[] = [];
  const probe = new Elysia().use(httpTelemetry()).get('/g1051/cards', ({ request }) =>
    publicWorkRead(deps, request, {}, (session) =>
      resourceCards(session, [
        ...selected.map((id) => ({
          id,
          summary: id,
          kind: 'agent' as const,
          order: '',
          types: ['https://rezics.com/vocab/Agent'],
        })),
        ...selectedWorks.map((id) => ({
          id,
          summary: id,
          kind: 'work' as const,
          order: '',
          types: ['https://schema.org/CreativeWork'],
        })),
      ]),
    ),
  );
  const measure = async (name: string, invoke: (headers: Headers) => Promise<Response>) => {
    const sql = captureSql();
    try {
      const { result, profile } = await profileRequest(
        sink,
        async (headers) => {
          const response = await invoke(headers);
          const text = await response.text();
          expect(response.status, text).toBe(200);
          const body = JSON.parse(text) as ResourceCard[] | { result: { items: ResourceCard[] } };
          return Array.isArray(body) ? body : body.result.items;
        },
        {
          service: 'g-1051-query',
          peers: { fuseki: Bun.env.FUSEKI_URL! },
          flush: flushTelemetryTraces,
        },
      );
      const captured = sql.snapshot();
      evidence.push({
        name,
        returned: result.length,
        sqlFamilies: captured.families,
        sqlShapes: captured.shapes,
        ...Object.fromEntries(Object.entries(profile).filter(([key]) => key !== 'spans')),
      });
      expect(profile.postgresStatements).toBe(captured.statements);
      if (!baseline)
        assertWorkCost(profile, {
          postgresStatements: name.startsWith('hydrate-') ? 20 : 48,
          fusekiRequests: 16,
        });
      return { result, cost: { statements: captured.statements, families: captured.families } };
    } finally {
      sql.stop();
      sink.clear();
    }
  };
  const cards = () => probe.handle(new Request('http://main.local/g1051/cards'));
  try {
    await grantRecordedPlatformUse(stack.accessPool, author.principalId, [
      'catalogue-import',
      'platform-admin',
    ]);
    for (let index = 0; index < 64; index++)
      agents.push(await home.provision(`${marker} ${index}`, author.token));
    for (const signed of [false, true]) {
      const costs = [];
      for (const count of [1, 16, 64]) {
        selected = agents.slice(0, count);
        const { result, cost } = await measure(
          `hydrate-${signed ? 'signed' : 'anonymous'}-${count}`,
          (headers) => {
            if (signed) headers.set('authorization', `Bearer ${author.token}`);
            return probe.handle(new Request('http://main.local/g1051/cards', { headers }));
          },
        );
        expect(result.map((row) => row.id)).toEqual(selected);
        costs.push(cost);
      }
      if (!baseline) {
        expect(costs[1]).toEqual(costs[0]);
        expect(costs[2]).toEqual(costs[0]);
      }
    }
    await author.grant(MANAGE_SCOPE, MANAGE_ACTION);
    await author.grant('work:create:catalogue-import', 'work.create');
    const imported = await home.json<{ receipt: { work: string } }>(
      await home.call(
        'POST',
        '/v1/work-imports',
        {
          actingSubject: author.actor,
          input: {
            profile: 'work-catalogue-import-v1',
            expectedWorkHead: null,
            title: `${marker} mixed Work`,
            language: 'en',
            evidence: 'G1051 final policy fence',
            aliases: [],
            semanticTypes: [],
            credits: [],
            classifications: [],
          },
        },
        author.token,
      ),
      201,
    );
    await backfillPublicNames(stack.env);
    const command = async <T>(path: string, body: object) =>
      home.json<T>(
        await app.handle(
          new Request(`http://main.local${path}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${author.token}`,
              'idempotency-key': randomUUID(),
            },
            body: JSON.stringify({ ...body, actingSubject: author.actor }),
          }),
        ),
      );
    let generation = await command<{ generation: string; checkpoint: string; complete: boolean }>(
      '/v1/discovery/generation-builds',
      {
        profile: 'discovery-generation-build-v1',
        basis: { scope: 'global', realm: null, context: null },
      },
    );
    while (!generation.complete)
      generation = await advanceQueryPopulation(home, discovery, generation, [
        imported.receipt.work,
      ]);
    const head = await home.json<{ activeHeadRevision: string | null }>(
      await app.handle(
        new Request(
          `http://main.local/v1/discovery/generations/${generation.generation}?actingSubject=${encodeURIComponent(author.actor)}`,
          { headers: { authorization: `Bearer ${author.token}` } },
        ),
      ),
    );
    await command('/v1/discovery/generation-activations', {
      profile: 'discovery-generation-activation-v1',
      generation: generation.generation,
      expectedHeadRevision: head.activeHeadRevision,
    });
    const costs = [];
    const queryAgents = (headers = new Headers(), limit = 64) => {
      headers.set('content-type', 'application/json');
      return app.handle(
        new Request('http://main.local/v1/query', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            profile: 'resource-list-v1',
            context: 'global',
            scope: { kind: 'all' },
            sort: 'relevance',
            q: marker,
            limit,
            filter: { all: [{ facet: 'type', any: ['https://rezics.com/vocab/Agent'] }] },
          }),
        }),
      );
    };
    for (const limit of [1, 16, 64]) {
      const { result, cost } = await measure(`query-agents-${limit}`, (headers) =>
        queryAgents(headers, limit),
      );
      expect(result).toHaveLength(limit);
      expect(result.every((row) => agents.includes(row.id))).toBe(true);
      costs.push(cost);
    }
    if (!baseline) {
      expect(costs[1]).toEqual(costs[0]);
      expect(costs[2]).toEqual(costs[0]);
      const preferences = deps.personPreferences;
      const policy = preferences.publicDiscoveryProfiles.bind(preferences);
      let reads = 0;
      preferences.publicDiscoveryProfiles = async (ids) => {
        // The first read admitted every Agent. A concurrent SQL-only policy
        // write during name hydration must be seen by the closing owner read.
        if (++reads === 2)
          await stack.accessPool.query(
            `INSERT INTO access.person_preferences(agent_id,profile_visibility,version)
          VALUES ($1,'private',1) ON CONFLICT (agent_id) DO UPDATE SET profile_visibility='private',version=access.person_preferences.version+1`,
            [agents[0]],
          );
        return policy(ids);
      };
      selected = agents.slice(0, 16);
      try {
        const response = await cards();
        expect(response.status, await response.clone().text()).toBe(200);
        const result = (await response.json()) as ResourceCard[];
        expect(result.map((row) => row.id)).toEqual(selected.slice(1));
        expect(reads).toBe(3);
      } finally {
        preferences.publicDiscoveryProfiles = policy;
      }
      await stack.accessPool.query(
        `INSERT INTO access.agent_listing(agent_id,listing,version) VALUES ($1,'unlisted',1)`,
        [agents[1]],
      );
      await stack.accessPool.query('UPDATE access.authority_subject SET active=false WHERE id=$1', [
        agents[2],
      ]);
      const visible = await policy([
        ...agents.slice(0, 4),
        `https://rezics.com/id/${randomUUID()}`,
      ]);
      expect(visible).toEqual(new Set([agents[3]!]));
      const payloads = discovery.resourceCardPayloads.bind(discovery);
      discovery.resourceCardPayloads = async (...args) => {
        const rows = await payloads(...args);
        await stack.accessPool.query(
          `INSERT INTO access.person_preferences(agent_id,profile_visibility,version)
          VALUES ($1,'private',1) ON CONFLICT (agent_id) DO UPDATE SET profile_visibility='private'`,
          [agents[3]],
        );
        return rows;
      };
      selected = agents.slice(3, 5);
      selectedWorks = [imported.receipt.work];
      try {
        const response = await cards();
        expect(response.status, await response.clone().text()).toBe(200);
        const mixed = (await response.json()) as ResourceCard[];
        expect(mixed.map((row) => row.id)).toEqual([agents[4]!, imported.receipt.work]);
      } finally {
        discovery.resourceCardPayloads = payloads;
        selectedWorks = [];
      }
      // Even the provisioning controller's bearer cannot admit private,
      // unlisted or inactive Agents into this public catalogue.
      const filtered = await queryAgents(new Headers({ authorization: `Bearer ${author.token}` }));
      expect(filtered.status, await filtered.clone().text()).toBe(200);
      const page = (await filtered.json()) as { result: { items: ResourceCard[] } };
      expect(page.result.items).toHaveLength(60);
      expect(page.result.items.every((row) => !agents.slice(0, 4).includes(row.id))).toBe(true);
      const revoke = page.result.items[0]!.id;
      let previewReads = 0;
      discovery.resourceCardPayloads = async (...args) => {
        const rows = await payloads(...args);
        previewReads++;
        await stack.accessPool.query(
          `INSERT INTO access.person_preferences(agent_id,profile_visibility,version)
          VALUES ($1,'private',1) ON CONFLICT (agent_id) DO UPDATE SET profile_visibility='private'`,
          [revoke],
        );
        return rows;
      };
      try {
        const response = await app.handle(
          new Request('http://main.local/v1/query', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              profile: 'resource-list-v1',
              context: 'global',
              scope: { kind: 'all' },
              sort: 'relevance',
              q: marker,
              limit: 64,
            }),
          }),
        );
        expect(response.status, await response.clone().text()).toBe(200);
        const mixed = (await response.json()) as { result: { items: ResourceCard[] } };
        expect(previewReads).toBe(1);
        expect(mixed.result.items.map((row) => row.id)).toContain(imported.receipt.work);
        expect(mixed.result.items.map((row) => row.id)).not.toContain(revoke);
      } finally {
        discovery.resourceCardPayloads = payloads;
      }
      preferences.publicDiscoveryProfiles = async () => {
        throw new Error('owner unavailable');
      };
      try {
        expect((await queryAgents()).status).toBe(503);
      } finally {
        preferences.publicDiscoveryProfiles = policy;
      }
      await expect(
        policy(Array.from({ length: 65 }, () => `https://rezics.com/id/${randomUUID()}`)),
      ).rejects.toThrow();
      await expect(policy(['invalid'])).rejects.toThrow();
      const beforeRecovery = await policy(agents);
      await stack.accessPool.query('UPDATE access.recovery_fence SET open=false WHERE id');
      try {
        await expect(policy(agents.slice(0, 4))).rejects.toThrow('recovery');
      } finally {
        await stack.accessPool.query('UPDATE access.recovery_fence SET open=true WHERE id');
      }
      expect(await policy(agents)).toEqual(beforeRecovery);
    }
  } finally {
    writeFileSync(
      join(Bun.env.REZICS_QA_ARTIFACT_DIR!, `g-1051-agents-${baseline ? 'before' : 'after'}.json`),
      JSON.stringify({ evidence }, null, 2),
    );
    await home.stop();
    await shutdownTelemetry();
    await sink.stop();
  }
}, 180_000);
