import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  startTelemetry,
  flushTelemetryTraces,
  shutdownTelemetry,
} from '@rezics/observability/runtime';
import { assertWorkCost, profileRequest, startWorkProfileSink } from './work-profile.ts';
import { isForegroundOperation } from '../integration/support/operation-cost.ts';

/** The same page/build cohort runs at 100, then isolated restores of 1000 and
 * 10000 command-created Works. Before implementations are retained in .temp. */
export async function classificationCostProfile() {
  let restored:
    | Awaited<
        ReturnType<
          (typeof import('../../../scripts/load/catalogue-backup.ts'))['restoreCatalogueBackup']
        >
      >
    | undefined;
  const corpus = Bun.env.G1041_BACKUP
    ? (JSON.parse(readFileSync(resolve(dirname(Bun.env.G1041_BACKUP), 'corpus.json'), 'utf8')) as {
        scale: number;
        works: { work: string; mainVersion: string }[];
        definitions: { sense: string; concept: string; definitionRevision: string }[];
      })
    : undefined;
  if (Bun.env.G1041_BACKUP) {
    const { restoreCatalogueBackup } = await import('../../../scripts/load/catalogue-backup.ts');
    const runId = `g1041-restore-${randomUUID().slice(0, 8)}`;
    restored = await restoreCatalogueBackup(Bun.env.G1041_BACKUP, runId);
    Object.assign(process.env, restored.apps, { REZICS_QA_RUN_ID: runId });
  }
  const sink = startWorkProfileSink({ settleMs: 25 });
  startTelemetry('g-1041-classification', {
    ...process.env,
    ...sink.env,
    OTEL_TRACES_SAMPLER_ARG: '0',
  });
  const { Elysia } = await import('elysia');
  const { httpTelemetry } = await import('@rezics/observability/elysia');
  const { startHomeStack } = await import('../integration/feed-read-support.ts');
  const { workRead } = await import('../../../services/main/src/modules/work/read-session.ts');
  const current = await import('../../../services/main/src/modules/work/read-classifications.ts');
  const discovery = await import('../../../services/main/src/modules/discovery/source.ts');
  const before = Bun.env.G1041_BEFORE === '1';
  const reader = before
    ? ((await import(resolve('.temp/g-1041/work-before.ts'))) as typeof current)
    : current;
  const projector = before
    ? ((await import(resolve('.temp/g-1041/discovery-before.ts'))) as typeof discovery)
    : discovery;
  // Earlier files' outbox positions are outside this fixture's preparation.
  const home = await startHomeStack('g-1041-classification', { projectionStart: 'current' });
  const { stack, author } = home;
  const definitions = [...(corpus?.definitions ?? [])];
  const works = [...(corpus?.works ?? [])];
  const evidence: Record<string, unknown>[] = [];
  const command = async <T>(path: string, body: object, status = 201) =>
    home.json<T>(
      await home.call('POST', path, { ...body, actingSubject: author.actor }, author.token),
      status,
    );
  try {
    await author.grant('classification:define:global', 'classification.proposition.define');
    await author.grant('classification:decide:global', 'classification.decision.set');
    await author.grant('work:create:catalogue-import', 'work.create');
    const creditedAuthor = await home.provision('G1041 catalogue author', author.token);
    for (let index = definitions.length; index < 21; index++)
      definitions.push(
        await command('/v1/classification-vocabulary', {
          profile: 'classification-proposition-v2',
          scheme: null,
          labels: [{ language: 'en', value: `G1041 topic ${index}` }],
          alternativeLabels: [],
          broader: [],
          narrower: [],
        }),
      );
    if (!corpus) {
      const result = await command<{
        items: { status: string; receipt: { work: string; mainVersion: string } }[];
      }>(
        '/v1/work-imports/bulk',
        {
          items: Array.from({ length: 100 }, (_, index) => ({
            key: randomUUID(),
            input: {
              profile: 'work-catalogue-import-v1',
              expectedWorkHead: null,
              title: `G1041 Work ${index}`,
              language: 'en',
              evidence: 'G1041 bounded classification profile',
              aliases: [],
              semanticTypes: [],
              credits: [{ agent: creditedAuthor, role: 'author' }],
              classifications: [
                {
                  sense: definitions[0]!.sense,
                  expectedSenseHead: definitions[0]!.definitionRevision,
                  expectedDecisionHead: null,
                  outcome: 'accepted',
                },
              ],
            },
          })),
        },
        200,
      );
      expect(result.items.every((row) => row.status === 'succeeded')).toBe(true);
      works.push(...result.items.map((row) => row.receipt));
    }
    const importedTarget = await command<{ receipt: { work: string; mainVersion: string } }>(
      '/v1/work-imports',
      {
        input: {
          profile: 'work-catalogue-import-v1',
          expectedWorkHead: null,
          title: 'G1041 dense classification Work',
          language: 'en',
          evidence: 'G1041 per-Work overflow sentinel',
          aliases: [],
          semanticTypes: [],
          credits: [],
          classifications: [
            {
              sense: definitions[0]!.sense,
              expectedSenseHead: definitions[0]!.definitionRevision,
              expectedDecisionHead: null,
              outcome: 'accepted',
            },
          ],
        },
      },
    );
    const target = importedTarget.receipt;
    for (const definition of definitions.slice(1))
      await command('/v1/classification-decisions', {
        profile: 'classification-direct-decision-v1',
        work: target.work,
        mainVersion: target.mainVersion,
        sense: definition.sense,
        context: { kind: 'global' },
        expectedDecisionHead: null,
        outcome: 'accepted',
      });
    let selection: string[] | undefined;
    const probe = new Elysia()
      .use(httpTelemetry())
      .get('/g1041/page', ({ request }) =>
        workRead(home.deps, request, { limit: 20 }, (session) =>
          reader.readWorkClassifications(session, target.work, selection),
        ),
      )
      .post('/g1041/build', ({ request }) =>
        workRead(home.deps, request, {}, (session) =>
          projector.projectDiscoveryBatch(
            session,
            { scope: 'global', realm: null, context: null },
            '',
            {
              works: works
                .slice(1, 25)
                .map((row) => row.work)
                .sort(),
              limit: 24,
            },
          ),
        ),
      );
    const measured = async (name: string, path: string, method = 'GET') => {
      const { result, profile } = await profileRequest(
        sink,
        async (headers) => {
          const response = await probe.handle(
            new Request(`http://main.local${path}`, { headers, method }),
          );
          const text = await response.text();
          expect(response.status, text).toBe(200);
          return JSON.parse(text) as {
            items: { sense?: string }[];
            after?: string;
            nextCursor?: string | null;
          };
        },
        {
          service: 'g-1041-classification',
          peers: { fuseki: Bun.env.FUSEKI_URL! },
          flush: flushTelemetryTraces,
        },
      );
      evidence.push({
        name,
        returned: result.items.length,
        ...Object.fromEntries(Object.entries(profile).filter(([key]) => key !== 'spans')),
      });
      expect(profile.fusekiRequests).toBeGreaterThan(0);
      if (!before)
        assertWorkCost(profile, {
          fusekiRequests: 20,
          fusekiReceivedBytes: 256 * 1024,
          fusekiSentBytes: method === 'POST' ? 512 * 1024 : 128 * 1024,
          totalLatencyMs: 10_000,
        });
      sink.clear();
      return result;
    };
    for (const count of [1, 3, 20]) {
      selection = count <= 3 ? definitions.slice(0, count).map((row) => row.sense) : undefined;
      const result = await measured(`page-${count}-senses`, '/g1041/page');
      expect(result.items).toHaveLength(count);
      if (count === 20) expect(result.nextCursor).toBeString();
    }
    const built = await measured('build-24-works', '/g1041/build', 'POST');
    if (!before) expect(built.items).toHaveLength(24);
    // The per-Work sentinel survives alongside a quiet neighbour in one batch.
    const batch = await workRead(
      home.deps,
      new Request('http://main.internal/g1041-sentinel'),
      {},
      (session) => current.readPublicWorkClassifications(session, [target.work, works[1]!.work]),
    );
    expect(batch.get(target.work)?.after).toBeString();
    expect(batch.get(works[1]!.work)?.after).toBeNull();
    // Movement between candidate and decision exchanges never mixes positions.
    const native = stack.fuseki.query.bind(stack.fuseki);
    stack.fuseki.query = async (...args) => {
      const result = await native(...args);
      // Background probes share this client. A moved sequence is the foreground
      // read's fault, so a scheduler query must keep the sequence it observed.
      if (isForegroundOperation() && args[0].includes('SELECT ?index ?epoch ?sequence')) {
        for (const row of result.results?.bindings ?? []) row.sequence!.value = '999999999';
      }
      return result;
    };
    try {
      await expect(
        workRead(home.deps, new Request('http://main.internal/g1041-movement'), {}, (session) =>
          current.readWorkClassifications(session, target.work, [definitions[0]!.sense]),
        ),
      ).rejects.toThrow('incomplete');
    } finally {
      stack.fuseki.query = native;
    }
  } finally {
    writeFileSync(
      join(
        Bun.env.REZICS_QA_ARTIFACT_DIR!,
        `g-1041-classification-${before ? 'before' : 'after'}.json`,
      ),
      JSON.stringify(
        {
          scale: corpus?.scale ?? 100,
          restoreMs: restored?.elapsedMs ?? null,
          evidence,
          unobserved: ['OS/storage-cold caches', 'native index entries examined'],
        },
        null,
        2,
      ),
    );
    await home.stop();
    await shutdownTelemetry();
    await sink.stop();
    await restored?.stop();
  }
}

if (import.meta.main) await classificationCostProfile();
