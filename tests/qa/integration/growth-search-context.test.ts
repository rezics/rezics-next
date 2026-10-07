import { expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import type {
  FusekiClient,
  SparqlResult,
} from '../../../services/main/src/infrastructure/fuseki.ts';
import { isForegroundOperation } from './support/operation-cost.ts';
import { accessWithBaseline } from '../fixtures/access-baseline.ts';
import { AccessPolicyOwner } from '../../../services/main/src/modules/access/policy-owner.ts';
import { CONTEXT_LIMITS } from '../../../services/main/src/modules/context/schema.ts';
import { AccessJudgments } from '../../../services/main/src/modules/judgment/access.ts';
import { searchRoutes } from '../../../services/main/src/routes/search.ts';
import { contextFixture, nativeId, RV, shortId } from './context-fixture.ts';

test('SEARCH10: real Context interpretation reads stay bounded as consumers and inherited depth grow', async () => {
  const f = await contextFixture(Bun.env as Record<string, string>);
  try {
    const object = nativeId(),
      relation = `${RV}growthRelation`,
      definition = nativeId();
    await f.grant('context:create:root', 'context.create');
    type Context = { context: string; semanticRevision: string };
    const contexts: Context[] = [];
    const create = async (base: string | null, entries: object[]) => {
      const next = await f.json<Context>(
        await f.call('POST', '/v1/contexts', {
          profile: 'context-v1',
          role: 'shared',
          disclosure: 'public',
          base,
          entries,
          actingSubject: f.actorA,
        }),
        201,
      );
      contexts.push(next);
      return next;
    };
    const base = await create(null, [
      { target: object, relation, state: 'defined', definition, applicability: [] },
    ]);
    const consumers: string[] = [];
    const original = f.env.fuseki;
    const measured = new AsyncLocalStorage<true>();
    let queryCalls = 0,
      selectionRows = 0,
      chainRows = 0,
      chainCalls = 0;
    const shapes: string[] = [];
    const meter = new Proxy(original, {
      get(target, property) {
        if (property === 'query')
          return async (sparql: string, maxResponseBytes?: number): Promise<SparqlResult> => {
            // Schedulers and other files' follow-up reads share this client.
            // Only the interpretation request under measurement is the cost.
            if (!measured.getStore() || !isForegroundOperation()) {
              return target.query(sparql, maxResponseBytes);
            }
            queryCalls++;
            shapes.push(sparql.replace(/\s+/g, ' ').slice(0, 140));
            const result = await target.query(sparql, maxResponseBytes);
            if (sparql.includes('SELECT ?key ?head ?state ?context ?revision')) {
              selectionRows += result.results?.bindings.length ?? 0;
            }
            if (sparql.includes('rv:baseRevision*')) {
              chainCalls++;
              chainRows += result.results?.bindings.length ?? 0;
            }
            return result;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as FusekiClient;
    const measure = async (realm: string, explicit: Context | null) => {
      queryCalls = 0;
      selectionRows = 0;
      chainRows = 0;
      chainCalls = 0;
      shapes.length = 0;
      f.env.fuseki = meter;
      try {
        const previewBody = {
          profile: 'context-interpretation-v1',
          speaker: { kind: 'realm', realm },
          object,
          relation,
          explicit: explicit
            ? { context: explicit.context, semanticRevision: explicit.semanticRevision }
            : null,
          actingSubject: f.actorA,
        };
        return await measured.run(true, async () => {
          const response = await f.call('POST', '/v1/context-interpretations', previewBody);
          if (response.status !== 200) console.error('growth preview input', previewBody);
          const result = await f.json<{ state: string; definition: string; sourcePosition: object }>(
            response,
            200,
          );
          expect(result).toMatchObject({ state: 'resolved', definition });
          return { queries: queryCalls, selectionRows, chainRows, chainCalls, shapes: [...shapes] };
        });
      } finally {
        f.env.fuseki = original;
      }
    };
    const consumerSamples: Array<{
      consumers: number;
      queries: number;
      selectionRows: number;
      chainRows: number;
      chainCalls: number;
    }> = [];
    for (let index = 0; index < 16; index++) {
      const realm = await f.realm(`Growth consumer ${index}`);
      consumers.push(realm.realm);
      await f.grant(`context:select:${realm.realm}`, 'context.select');
      await f.json(
        await f.call('POST', `/v1/realms/${shortId(realm.realm)}/context-selections`, {
          profile: 'context-selection-v1',
          scope: { kind: 'object', object },
          selection: { context: base.context, semanticRevision: base.semanticRevision },
          expectedHead: null,
          actingSubject: f.actorA,
        }),
        201,
      );
      if (![0, 3, 15].includes(index)) continue;
      const sample = { consumers: index + 1, ...(await measure(consumers[0]!, null)) };
      consumerSamples.push(sample);
      expect(sample).toMatchObject({ queries: 4, selectionRows: 1, chainRows: 1, chainCalls: 1 });
    }
    const depthSamples: Array<{
      depth: number;
      queries: number;
      selectionRows: number;
      chainRows: number;
      chainCalls: number;
    }> = [];
    depthSamples.push({ depth: 0, ...(await measure(consumers[0]!, base)) });
    for (let depth = 1; depth <= CONTEXT_LIMITS.inheritanceDepth; depth++) {
      const child = await create(contexts.at(-1)!.semanticRevision, []);
      if (depth === 4 || depth === CONTEXT_LIMITS.inheritanceDepth) {
        depthSamples.push({ depth, ...(await measure(consumers[0]!, child)) });
      }
    }
    for (const sample of depthSamples) {
      expect(sample).toMatchObject({ queries: 3, selectionRows: 0, chainCalls: 1 });
      expect(sample.chainRows).toBe(sample.depth + 1);
      expect(sample.chainRows).toBeLessThanOrEqual(CONTEXT_LIMITS.inheritanceDepth + 1);
    }
    expect(depthSamples.map((sample) => sample.depth)).toEqual([0, 4, 8]);
    expect(
      (
        await f.call('POST', '/v1/contexts', {
          profile: 'context-v1',
          role: 'shared',
          disclosure: 'public',
          base: contexts.at(-1)!.semanticRevision,
          entries: [],
          actingSubject: f.actorA,
        })
      ).status,
    ).toBe(409);
    await f.grant('semantic:create:root', 'semantic.change');
    const relationDefinition = await f.json<{ revision: string }>(
      await f.call('POST', '/v1/semantic/changes', {
        profile: 'semantic-change-v1',
        actingSubject: f.actorA,
        expectedHead: null,
        state: {
          component: 'definition',
          kind: 'relation',
          lifecycle: 'active',
          successor: null,
          roles: [
            { key: 'work', minParticipants: 1, maxParticipants: 1, ordered: false },
            { key: 'lead', minParticipants: 1, maxParticipants: 1, ordered: false },
          ],
        },
      }),
      201,
    );
    const search = searchRoutes(f.env.fuseki, {
      environment: f.env,
      account: f.account.verifier,
      access: accessWithBaseline(f.accessPool, f.env.fuseki),
      judgments: new AccessJudgments(f.accessPool),
      accessPolicy: new AccessPolicyOwner(f.accessPool),
    } as Parameters<typeof searchRoutes>[1]);
    const grouped = await search.handle(
      new Request('http://main.local/v1/queries', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${f.account.tokenA}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          profile: 'public-grouped-statement-phrase-v1',
          actingSubject: f.actorA,
          context: { kind: 'realm-local', id: consumers[0] },
          phrase: 'absent-growth-phrase',
          language: 'en',
          relation: {
            definition: relationDefinition.revision,
            workRole: 'work',
            participantRole: 'lead',
          },
          conditions: [
            {
              predicate: relation,
              relationDefinition: nativeId(),
              value: object,
              context: contexts.at(-1)!.context,
              semanticRevision: contexts.at(-1)!.semanticRevision,
              applicability: [],
            },
          ],
          countGrain: 'work',
          facetMode: 'fully-filtered',
        }),
      }),
    );
    const groupedResult = (await grouped.json()) as Record<string, unknown>;
    expect(grouped.status).toBe(200);
    expect(groupedResult).toMatchObject({
      complete: true,
      total: 0,
      countPrecision: 'exact',
      facetPrecision: 'exact',
    });
    expect(groupedResult.facets).toHaveLength(1);
    if (!Bun.env.REZICS_QA_ARTIFACT_DIR) throw new Error('QA artifact directory is unavailable');
    writeFileSync(
      join(Bun.env.REZICS_QA_ARTIFACT_DIR, 'search-context-growth.json'),
      `${JSON.stringify(
        {
          consumerSamples,
          depthSamples,
          maxDepth: CONTEXT_LIMITS.inheritanceDepth,
          native: 'QA Fuseki query endpoint with real Context and selection commands',
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await f.close();
  }
}, 180_000);
