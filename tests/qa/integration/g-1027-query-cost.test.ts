import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  startTelemetry,
  flushTelemetryTraces,
  shutdownTelemetry,
} from '@rezics/observability/runtime';
import { assertWorkCost, profileRequest, startWorkProfileSink } from '../support/work-profile.ts';
import type { ResourceListQuery } from '../../../services/main/src/modules/query/resource-contract.ts';
import type { FilterCondition } from '../../../model/definitions/filter-document-v1.ts';
import { queryProfileProcess } from '../../../services/main/tests/g-1053-profile-process.ts';

interface Page {
  sourcePosition: { dataEpoch: string; sequence: string };
  items: { id: string; kind: string }[];
  nextCursor: string | null;
  complete: boolean;
  count: { value: number; kind: string };
}
interface Definition {
  concept: string;
  sense: string;
  definitionRevision: string;
}
interface SqlPlan {
  'Node Type': string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Index Name'?: string;
  'Rows Removed by Filter'?: number;
  Plans?: SqlPlan[];
}
const planNodes = (node: SqlPlan): SqlPlan[] => [node, ...(node.Plans ?? []).flatMap(planNodes)];

/** Small, reproducible counterexamples, not a capacity qualification. Each
 * scale changes unrelated vocabulary/corpus only; the target relation stays
 * fixed. Cold below means first read after writes, not restarted storage. */
test('G1027: unified Query keeps ranked joins, chip resolution and page hydration bounded across three scales', async () => {
  if (Bun.env.G1053_QUERY_CHILD !== 'g-1027-query-cost.test.ts')
    return queryProfileProcess('g-1027-query-cost.test.ts');
  const sink = startWorkProfileSink({ settleMs: 50 });
  startTelemetry('g-1027-query', { ...process.env, ...sink.env });
  const { meterStatements } = await import('./feed-read-support.ts');
  const { startQueryHome, advanceQueryPopulation } =
    await import('../../../services/main/tests/g-1053-query-fixture.ts');
  const { createMainApp } = await import('../../../services/main/src/app.ts');
  const { DiscoveryProjection, discoveryResourceSeekSql } =
    await import('../../../services/main/src/modules/discovery/store.ts');
  const { backfillPublicNames } =
    await import('../../../services/main/src/modules/search/names.ts');
  const { AccessPolicyOwner } =
    await import('../../../services/main/src/modules/access/policy-owner.ts');
  const { activateMetadataWork, metadataWorkRequestDigest } =
    await import('../../../services/main/src/modules/work/activate.ts');
  const { selectMainDefault, mainSelectionDigest } =
    await import('../../../services/main/src/modules/work/select-main.ts');
  const { MANAGE_SCOPE, MANAGE_ACTION } =
    await import('../../../services/main/src/modules/recommendation/derived-generation.ts');
  const home = await startQueryHome('g-1027-query');
  const { stack, author, reader } = home;
  const projection = new DiscoveryProjection(stack.accessPool);
  const app = createMainApp(stack.fuseki, {
    ...home.deps,
    discovery: projection,
    accessPolicy: new AccessPolicyOwner(stack.accessPool),
  });
  const sql = meterStatements();
  const evidence: Record<string, unknown>[] = [];
  const diagnostics: Record<string, unknown>[] = [];
  const started = Date.now();
  const baseline = process.env.G1027_BASELINE === '1';
  const token = `g1027${randomUUID().replaceAll('-', '')}`;
  const works: { work: string; mainVersion: string }[] = [];
  const backgroundWorks: string[] = [];
  const definitions: Definition[] = [];
  const call = (path: string, body?: unknown, bearer?: string, extra?: Headers) => {
    const headers = new Headers(extra);
    headers.set('accept-language', 'en');
    if (body) {
      headers.set('content-type', 'application/json');
      headers.set('idempotency-key', randomUUID());
    }
    if (bearer) headers.set('authorization', `Bearer ${bearer}`);
    return app.handle(
      new Request(`http://main.local${path}`, {
        method: body ? 'POST' : 'GET',
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  };
  const json = async <T>(path: string, body?: unknown, bearer?: string, status = 200) =>
    home.json<T>(await call(path, body, bearer), status);
  const refresh = async () => {
    let row = await json<{ generation: string; checkpoint: string; complete: boolean }>(
      '/v1/discovery/generation-builds',
      {
        profile: 'discovery-generation-build-v1',
        actingSubject: author.actor,
        basis: { scope: 'global', realm: null, context: null },
      },
      author.token,
    );
    while (!row.complete) {
      const previous = row.checkpoint;
      row = await advanceQueryPopulation(home, projection, row, [
        ...works.map((work) => work.work),
        ...backgroundWorks,
      ]);
      expect(row.complete || row.checkpoint !== previous).toBe(true);
    }
    const head = await json<{ activeHeadRevision: string | null }>(
      `/v1/discovery/generations/${row.generation}?actingSubject=${encodeURIComponent(author.actor)}`,
      undefined,
      author.token,
    );
    await json(
      '/v1/discovery/generation-activations',
      {
        profile: 'discovery-generation-activation-v1',
        actingSubject: author.actor,
        generation: row.generation,
        expectedHeadRevision: head.activeHeadRevision,
      },
      author.token,
    );
  };
  try {
    await author.grant(MANAGE_SCOPE, MANAGE_ACTION);
    await author.grant('classification:define:global', 'classification.proposition.define');
    await author.grant('classification:decide:global', 'classification.decision.set');
    await author.grant('work:create:catalogue-import', 'work.create');
    for (let i = 0; i < 8; i++)
      definitions.push(
        await json<Definition>(
          '/v1/classification-vocabulary',
          {
            profile: 'classification-proposition-v2',
            scheme: null,
            labels: [{ language: 'en', value: `${token} common topic ${i}` }],
            alternativeLabels: [],
            broader: [],
            narrower: [],
            actingSubject: author.actor,
          },
          author.token,
          201,
        ),
      );
    // Fifty-two results make page 50 a real continuation, not an OFFSET probe.
    {
      const title = `${token} common 小說 mixed 0`;
      const book = 'https://schema.org/Book';
      const created = await activateMetadataWork(stack.env, {
        title,
        language: 'en',
        semanticTypes: [book],
        admission: stack.admission(
          author.actor,
          'work:create:root',
          'work.create',
          metadataWorkRequestDigest(title, [book], 'en'),
        ),
      });
      const contribution = await stack.contribution(
        created.work,
        author.actor,
        'en',
        'G1027 Book body',
      );
      const input = {
        context: { kind: 'main-version-default' as const, id: created.mainVersion },
        work: created.work,
        contribution: contribution.contribution,
        publicationDecision: contribution.decision,
        expectedSelectionHead: null,
        selectionBasis: 'main-maintainer' as const,
        actingSubject: author.actor,
      };
      expect(
        (
          await selectMainDefault(
            stack.env,
            stack.admission(
              author.actor,
              `publication:select:${created.mainVersion}`,
              'publication.select',
              mainSelectionDigest(input),
            ),
            input,
          )
        ).outcome,
      ).toBe('succeeded');
      works.push(created);
    }
    const imported = await json<{
      complete: boolean;
      partial: boolean;
      items: { status: string; receipt: { work: string; mainVersion: string } }[];
    }>(
      '/v1/work-imports/bulk',
      {
        actingSubject: author.actor,
        items: Array.from({ length: 51 }, (_, offset) => {
          const index = offset + 1;
          return {
            key: randomUUID(),
            input: {
              profile: 'work-catalogue-import-v1',
              expectedWorkHead: null,
              title: `${token} common 小說 mixed ${index === 51 ? `${token}rare` : ''} ${index}`,
              language: 'en',
              evidence: 'G1027 public bulk cost cohort',
              aliases: [],
              semanticTypes: [],
              credits: [],
              classifications: (index === 51
                ? definitions
                : index % 2 === 0
                  ? definitions.slice(0, 1)
                  : []
              ).map((term) => ({
                sense: term.sense,
                expectedSenseHead: term.definitionRevision,
                expectedDecisionHead: null,
                outcome: 'accepted',
              })),
            },
          };
        }),
      },
      author.token,
    );
    expect(imported.complete).toBe(true);
    expect(imported.partial).toBe(false);
    expect(imported.items).toHaveLength(51);
    expect(imported.items.every((row) => row.status === 'succeeded')).toBe(true);
    works.push(...imported.items.map((row) => row.receipt));
    const privateWork = await stack.privateWork(author.actor, `${token} common hidden`);
    {
      const work = works[0]!,
        term = definitions[0]!;
      await json(
        '/v1/classification-decisions',
        {
          profile: 'classification-direct-decision-v1',
          context: { kind: 'global' },
          work: work.work,
          mainVersion: work.mainVersion,
          sense: term.sense,
          expectedDecisionHead: null,
          outcome: 'accepted',
          actingSubject: author.actor,
        },
        author.token,
        201,
      );
    }
    const workType = { facet: 'type', any: ['https://schema.org/CreativeWork'] };
    const base: ResourceListQuery = {
      profile: 'resource-list-v1',
      context: 'global',
      scope: { kind: 'all' },
      q: `${token} common`,
      sort: 'relevance',
      limit: 3,
      filter: { all: [workType] },
    };
    const topic = (operator: 'all' | 'none', size: number): FilterCondition => ({
      facet: 'concept',
      [operator]: definitions.slice(0, size).map((row) => row.concept),
    });
    const matrix: { name: string; query: ResourceListQuery; allowed: Set<string> }[] = [
      { name: 'common-work', query: base, allowed: new Set(works.map((row) => row.work)) },
      {
        name: 'rare-work',
        query: { ...base, q: `${token}rare` },
        allowed: new Set([works[51]!.work]),
      },
      {
        name: 'CJK',
        query: { ...base, q: `${token} common 小說` },
        allowed: new Set(works.map((row) => row.work)),
      },
      {
        name: 'mixed-script',
        query: { ...base, q: `${token} common 小說 mixed` },
        allowed: new Set(works.map((row) => row.work)),
      },
      {
        name: 'all-owners',
        query: { ...base, filter: undefined },
        allowed: new Set([
          ...works.map((row) => row.work),
          ...definitions.map((row) => row.concept),
        ]),
      },
      ...[1, 3, 8].map((size) => ({
        name: `include-${size}`,
        query: { ...base, filter: { all: [workType, topic('all', size)] } },
        allowed: new Set(
          size === 1
            ? works.filter((_, i) => i % 2 === 0 || i === 51).map((row) => row.work)
            : [works[51]!.work],
        ),
      })),
      {
        name: 'exclude',
        query: { ...base, filter: { all: [workType, topic('none', 1)] } },
        allowed: new Set(works.filter((_, i) => i % 2 === 1 && i !== 51).map((row) => row.work)),
      },
      {
        name: 'include-exclude',
        query: {
          ...base,
          filter: {
            all: [workType, topic('all', 1), { facet: 'concept', none: [definitions[1]!.concept] }],
          },
        },
        allowed: new Set(works.filter((_, i) => i % 2 === 0).map((row) => row.work)),
      },
      {
        name: 'selective-language',
        query: { ...base, filter: { all: [workType, { facet: 'language', any: ['ja'] }] } },
        allowed: new Set<string>(),
      },
      {
        name: 'unselective-language',
        query: { ...base, filter: { all: [workType, { facet: 'language', any: ['en'] }] } },
        allowed: new Set(works.map((row) => row.work)),
      },
      ...(['newest', 'updated'] as const).map((sort) => ({
        name: `text-${sort}`,
        query: { ...base, sort },
        allowed: new Set(works.map((row) => row.work)),
      })),
      ...(['newest', 'updated'] as const).map((sort) => ({
        name: `no-text-${sort}`,
        query: {
          ...base,
          q: undefined,
          sort,
          filter: { all: [workType, topic('all', 8)] },
        },
        allowed: new Set([works[51]!.work]),
      })),
      {
        name: 'union-newest',
        query: {
          ...base,
          q: undefined,
          sort: 'newest',
          filter: {
            all: [
              workType,
              { facet: 'concept', any: definitions.slice(0, 2).map((row) => row.concept) },
            ],
          },
        },
        allowed: new Set(works.filter((_, i) => i % 2 === 0 || i === 51).map((row) => row.work)),
      },
      {
        name: 'book-subtype',
        query: { ...base, filter: { all: [{ facet: 'type', any: ['https://schema.org/Book'] }] } },
        allowed: new Set([works[0]!.work]),
      },
    ];
    let unrelated = 0;
    for (const scale of [0, 16, 80]) {
      if (unrelated < scale) {
        const background = await json<{
          complete: boolean;
          partial: boolean;
          items: { status: string; receipt: { work: string } }[];
        }>(
          '/v1/work-imports/bulk',
          {
            actingSubject: author.actor,
            items: Array.from({ length: scale - unrelated }, (_, offset) => ({
              key: randomUUID(),
              input: {
                profile: 'work-catalogue-import-v1',
                expectedWorkHead: null,
                title: `Unrelated ${token} vocabulary ${unrelated + offset}`,
                language: 'en',
                evidence: 'G1027 public bulk background',
                aliases: [],
                semanticTypes: [],
                credits: [],
                classifications: [],
              },
            })),
          },
          author.token,
        );
        expect(background.complete).toBe(true);
        expect(background.partial).toBe(false);
        expect(background.items.every((row) => row.status === 'succeeded')).toBe(true);
        backgroundWorks.push(...background.items.map((row) => row.receipt.work));
      }
      while (unrelated < scale) {
        // Eight aliases per unrelated Concept challenge Work-only retrieval.
        await json(
          '/v1/classification-vocabulary',
          {
            profile: 'classification-proposition-v2',
            scheme: null,
            labels: ['en', 'fr', 'de', 'es', 'ja', 'zh-Hans', 'zh-Hant', 'ko'].map((language) => ({
              language,
              value: `${token} common distractor ${unrelated}`,
            })),
            alternativeLabels: [],
            broader: [],
            narrower: [],
            actingSubject: author.actor,
          },
          author.token,
          201,
        );
        unrelated++;
      }
      await backfillPublicNames(stack.env);
      await refresh();
      expect(Date.now() - started).toBeLessThan(600_000);
      for (const surface of ['typeahead', 'catalogue'] as const) {
        for (const rare of [false, true]) {
          const text = rare ? `${token}rare` : `${token} common`;
          const path =
            surface === 'typeahead'
              ? `/v1/search/typeahead?prefix=${encodeURIComponent(text)}`
              : `/v1/search/catalogue?q=${encodeURIComponent(text)}&limit=3`;
          for (const bearer of [undefined, reader.token]) {
            const before = sql.count();
            const { result, profile } = await profileRequest(
              sink,
              async (headers) => {
                const response = await call(path, undefined, bearer, headers);
                const body = await response.text();
                expect(response.status, body).toBe(200);
                const page = JSON.parse(body) as {
                  items?: { work: string }[];
                  results?: { work: string }[];
                };
                return page.items ?? page.results!;
              },
              {
                service: 'g-1027-query',
                peers: { fuseki: Bun.env.FUSEKI_URL! },
                flush: flushTelemetryTraces,
              },
            );
            expect(result).toHaveLength(rare ? 1 : surface === 'typeahead' ? 10 : 3);
            expect(result.every((row) => works.some((work) => work.work === row.work))).toBe(true);
            assertWorkCost(profile, { fusekiRequests: 72, fusekiReceivedBytes: 8 * 1024 * 1024 });
            evidence.push({
              scale,
              surface,
              name: rare ? 'rare' : 'common',
              viewer: bearer ? 'signed' : 'anonymous',
              returned: result.length,
              measuredSqlStatements: sql.count() - before,
              ...Object.fromEntries(Object.entries(profile).filter(([key]) => key !== 'spans')),
            });
          }
        }
      }
      const measured = async (
        name: string,
        query: ResourceListQuery,
        bearer?: string,
        cache = 'warm',
      ) => {
        const captured: string[] = [];
        let rankedDocuments = 0,
          sourceWorks = 0,
          candidateWorks = 0,
          hydratedWorks = 0;
        const native = stack.fuseki.query.bind(stack.fuseki);
        stack.fuseki.query = async (...args) => {
          captured.push(args[0]);
          const result = await native(...args);
          if (
            args[0].includes('BIND(rv:rankedText(rv:publicTitle') &&
            !args[0].includes('directory')
          )
            for (const row of result.results?.bindings ?? [])
              if (row.page)
                rankedDocuments += (JSON.parse(row.page.value) as { hits: unknown[] }).hits.length;
          return result;
        };
        const sourcePage = projection.resourcePage.bind(projection);
        const membership = projection.resourceMembership.bind(projection);
        const payloads = projection.resourceCardPayloads.bind(projection);
        projection.resourcePage = async (...args) => {
          const rows = await sourcePage(...args);
          sourceWorks += rows.length;
          return rows;
        };
        projection.resourceMembership = async (...args) => {
          candidateWorks += args[1].length;
          return membership(...args);
        };
        projection.resourceCardPayloads = async (...args) => {
          hydratedWorks += args[1].length;
          return payloads(...args);
        };
        const before = sql.count();
        try {
          const { result, profile } = await profileRequest(
            sink,
            async (headers) => {
              const response = await call('/v1/query', query, bearer, headers);
              const body = await response.text();
              expect(response.status, body).toBe(200);
              return (JSON.parse(body) as { result: Page }).result;
            },
            {
              service: 'g-1027-query',
              peers: { fuseki: Bun.env.FUSEKI_URL! },
              flush: flushTelemetryTraces,
            },
          );
          const joins = captured.filter((text) =>
            text.includes('SELECT DISTINCT ?r ?kind ?summary'),
          );
          const rankReads = captured.filter(
            (text) =>
              text.includes('BIND(rv:rankedText(rv:publicTitle') && !text.includes('directory'),
          );
          const conceptReads = captured.filter((text) =>
            text.includes('SELECT ?concept ?realm ?sense'),
          );
          const rechecks = joins.filter((text) => text.includes('REGEX(STR(rv:rankedText'));
          evidence.push({
            scale,
            name,
            cache,
            viewer: bearer ? 'signed' : 'anonymous',
            query,
            ids: result.items.map((row) => row.id),
            complete: result.complete,
            count: result.count,
            ...Object.fromEntries(Object.entries(profile).filter(([key]) => key !== 'spans')),
            measuredSqlStatements: sql.count() - before,
            joins: joins.length,
            rankReads: rankReads.length,
            conceptResolutionReads: conceptReads.length,
            candidateTextRechecks: rechecks.length,
            rankedDocuments,
            sourceWorks,
            candidateWorks,
            hydratedWorks,
            returned: result.items.length,
          });
          expect(result.items.map((row) => row.id)).not.toContain(privateWork.work);
          expect(profile.fusekiRequests).toBeGreaterThan(0);
          expect(sql.count() - before).toBeGreaterThan(0);
          if (!baseline) {
            assertWorkCost(profile, { fusekiRequests: 160, fusekiReceivedBytes: 4 * 1024 * 1024 });
            expect(conceptReads.length).toBeLessThanOrEqual(1);
            expect(hydratedWorks).toBeLessThanOrEqual(query.limit ?? 20);
            if (name === 'book-subtype') {
              expect(sourceWorks).toBe(1);
              expect(rankedDocuments).toBe(1);
            }
            if (name === 'include-3' || name === 'include-8') {
              expect(sourceWorks).toBe(1);
              expect(rankedDocuments).toBe(1);
            }
            if (name.startsWith('no-text-')) expect(sourceWorks).toBe(1);
            if (query.sort === 'relevance') {
              expect(joins.length).toBeLessThanOrEqual(rankReads.length);
              expect(rechecks).toHaveLength(0);
              if (query.filter?.all.some((node) => 'facet' in node && node.facet === 'type'))
                expect(rankReads.every((text) => text.includes('work'))).toBe(true);
              if (name === 'common-work') expect(rankReads).toHaveLength(1);
            }
          }
          if (name === 'no-text-newest' && !bearer && !baseline) {
            const generation = await projection.active(
              { scope: 'global', realm: null, context: null, owner: null },
              result.sourcePosition,
            );
            const plans = (
              await stack.accessPool.query<{ 'QUERY PLAN': { Plan: SqlPlan }[] }>(
                `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON, TIMING OFF) ${discoveryResourceSeekSql(false)}`,
                [generation.generation_id, '', [definitions[1]!.sense], 4],
              )
            ).rows;
            const nodes = planNodes(plans[0]!['QUERY PLAN'][0]!.Plan);
            expect(nodes.some((node) => node['Node Type'] === 'Seq Scan')).toBe(false);
            const index = nodes.find((node) => node['Index Name'] === 'discovery_recent_seek');
            expect(index).toBeDefined();
            expect(index!['Actual Rows'] * index!['Actual Loops']).toBe(1);
            expect(index!['Rows Removed by Filter'] ?? 0).toBe(0);
            diagnostics.push({ scale, kind: 'SQL execution plan', plan: plans });
          }
          if (
            scale === 80 &&
            name === 'common-work' &&
            !bearer &&
            cache === 'first-after-writes' &&
            !baseline
          ) {
            const { captureFusekiPlan } = await import('../../../scripts/load/fuseki-plan.ts');
            const directory = join(
              process.cwd(),
              '.temp/g-1027',
              `plans-${Bun.env.REZICS_QA_RUN_ID}`,
            );
            for (const [index, text] of [rankReads[0], joins[0]].entries()) {
              expect(text).toBeDefined();
              diagnostics.push({
                kind: 'ARQ algebra',
                directory,
                ...captureFusekiPlan(text!, { label: `g-1027-query-${index}`, directory }),
              });
            }
          }
          return result;
        } finally {
          stack.fuseki.query = native;
          projection.resourcePage = sourcePage;
          projection.resourceMembership = membership;
          projection.resourceCardPayloads = payloads;
        }
      };
      for (const [cellIndex, cell] of matrix.entries()) {
        // All-owner results also include this scale's public distractor Concepts.
        for (const bearer of [undefined, reader.token]) {
          const page = await measured(
            cell.name,
            cell.query,
            bearer,
            cellIndex === 0 ? 'first-after-writes' : 'warm',
          );
          if (cell.name !== 'all-owners')
            expect(page.items.every((row) => cell.allowed.has(row.id))).toBe(true);
          expect(page.items.length).toBe(Math.min(3, cell.allowed.size));
          if (cell.allowed.size <= 3 && cell.name !== 'all-owners') {
            expect(new Set(page.items.map((row) => row.id))).toEqual(cell.allowed);
            expect(page.complete).toBe(true);
          }
          if (cellIndex < 2) {
            const warm = await measured(cell.name, cell.query, bearer);
            expect(warm.items).toEqual(page.items);
            expect(warm.count).toEqual(page.count);
            expect(warm.complete).toBe(page.complete);
          }
        }
      }
      for (const sort of ['relevance', 'newest', 'updated'] as const) {
        let cursor: string | undefined;
        const seen = new Set<string>();
        for (let number = 1; number <= 50; number++) {
          const query = { ...base, sort, limit: 1, cursor };
          const page =
            number === 1 || number === 10 || number === 50
              ? await measured(`page-${number}-${sort}`, query)
              : (await json<{ result: Page }>('/v1/query', query)).result;
          expect(page.items).toHaveLength(1);
          expect(works.some((row) => row.work === page.items[0]!.id)).toBe(true);
          expect(seen.has(page.items[0]!.id)).toBe(false);
          seen.add(page.items[0]!.id);
          expect(page.nextCursor).not.toBeNull();
          cursor = page.nextCursor!;
        }
      }
      const union = matrix.find((cell) => cell.name === 'union-newest')!;
      let cursor: string | undefined;
      const unionSeen = new Set<string>();
      for (let number = 1; number <= 20; number++) {
        const page = (await json<{ result: Page }>('/v1/query', { ...union.query, cursor })).result;
        for (const row of page.items) {
          expect(unionSeen.has(row.id)).toBe(false);
          unionSeen.add(row.id);
        }
        if (page.complete) {
          expect(page.count).toEqual({ kind: 'exact', value: union.allowed.size });
          break;
        }
        expect(page.nextCursor).not.toBeNull();
        cursor = page.nextCursor!;
      }
      expect(unionSeen).toEqual(union.allowed);
    }
  } finally {
    writeFileSync(
      join(Bun.env.REZICS_QA_ARTIFACT_DIR!, `g-1027-query-${baseline ? 'before' : 'after'}.json`),
      JSON.stringify(
        {
          evidence,
          diagnostics,
          preparationAndRunMs: Date.now() - started,
          unobserved: [
            'native Lucene postings/candidate visits',
            'SQL plans outside the new Work posting seek',
            'storage-cold reads',
            'private admission profile',
            'Discover sections (G-1029)',
            'legacy complete-relation Work profiles',
            'history/follows/membership dimensions',
          ],
        },
        null,
        2,
      ),
    );
    sql.restore();
    await home.stop();
    await shutdownTelemetry();
    await sink.stop();
  }
}, 480_000);
