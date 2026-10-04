import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startTelemetry, flushTelemetryTraces, shutdownTelemetry } from '@rezics/observability/runtime';
import { profileRequest, startWorkProfileSink } from '../support/work-profile.ts';
import { workProfileCorpusApi } from '../../../scripts/load/work-profile-corpus.ts';
import { seedCatalogueProfileWorks } from '../../../scripts/load/catalogue-work.ts';
import { seedPublicProfileWork } from '../../../scripts/load/work-profile-work.ts';
import { qaTdbStorage, tdbGrowth } from '../../../scripts/load/tdb-growth.ts';
import { retainCatalogueBackup } from '../../../scripts/load/catalogue-backup.ts';
import { CATALOGUE_IMPORT_SCOPE, type CatalogueImportInput } from '../../../services/main/src/modules/work/catalogue-import.ts';
import { scalePreparationBudgetMs } from '../../../scripts/qa/stack-environment.ts';

/** Build through public APIs exactly once, then retain stopped owner cuts for
 * subsequent independent Query runs. Default 100 is diagnostic; 1000/10000 are
 * opt-in. The 600s preparation ceiling is never extended by this test. */
test.skipIf(Bun.env.G1038_REUSE === '1')('G1038: disk-backed single, compound and bulk writes qualify command catalogue preparation', async () => {
  const scales = (Bun.env.G1038_SCALES ?? '100').split(',').map(Number);
  if (scales.some((scale, index) => ![100, 1000, 10000].includes(scale) || scale <= (scales[index - 1] ?? 0)))
    throw new Error('Invalid G1038_SCALES');
  const sink = startWorkProfileSink({ settleMs: 25 });
  startTelemetry('g-1038-scale', { ...process.env, ...sink.env, OTEL_TRACES_SAMPLER_ARG: '0' });
  const { startHomeStack } = await import('./feed-read-support.ts');
  const { createMainApp } = await import('../../../services/main/src/app.ts');
  const { BACKPRESSURE_PROFILE_V1 } = await import('../../../services/main/src/operations/backpressure.ts');
  const startedAt = Number(Bun.env.REZICS_QA_PREPARATION_STARTED_AT), started = performance.now();
  const signal = AbortSignal.timeout(scalePreparationBudgetMs(startedAt));
  const directory = resolve('.temp/g-1038'); mkdirSync(directory, { recursive: true });
  const evidence: Record<string, unknown> = { qaRunId: Bun.env.REZICS_QA_RUN_ID, scales,
    preparation: 'public Work imports with one native author and one global classification',
    vocabulary: 8, batchSize: 128, brokerProfile: 'catalogue-preparation-v1', brokerMaxBacklog: 15000, samples: [], backups: [], completedWorks: 0,
    unobserved: ['native index pages modified', 'OS-cold storage', '128/512 vocabulary scale probe'] };
  const save = () => writeFileSync(resolve(directory, 'catalogue-throughput.json'), JSON.stringify(evidence, null, 2));
  let home = await startHomeStack('g-1038-scale'), homeClosed = false;
  const definitions: { sense: string; concept: string; definitionRevision: string }[] = [];
  const works: Awaited<ReturnType<typeof seedCatalogueProfileWorks>> = [];
  const key = `g1038:${randomUUID()}`;
  let actor = '', api: ReturnType<typeof workProfileCorpusApi>;
  const initialize = async () => {
    // Measure durable command preparation separately from relay catch-up. Every
    // event remains in the stopped cut; production's 1000-position ceiling stays.
    home.app = createMainApp(home.stack.fuseki, { ...home.deps, backpressureProfile: {
      ...BACKPRESSURE_PROFILE_V1, id: 'catalogue-preparation-v1',
      broker: { ...BACKPRESSURE_PROFILE_V1.broker, maxBacklog: 15000 } } });
    actor = await home.provision('Catalogue import author', home.author.token);
    for (const [scope, action] of [[CATALOGUE_IMPORT_SCOPE, 'work.create'],
      ['classification:define:global', 'classification.proposition.define'],
      ['classification:decide:global', 'classification.decision.set']]) {
      await home.stack.accessPool.query('INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await home.stack.accessPool.query(`INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), home.author.principalId, actor, action]);
      await home.stack.accessPool.query(`INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), actor, scope, action]);
    }
    api = workProfileCorpusApi('http://main.local', home.author.token, { signal,
      fetch: (async (input, init) => { const response = await home.app.handle(new Request(input, init));
        if (!response.ok) { evidence.lastResponse = await response.clone().text(); save(); } return response; }) as typeof fetch });
  };
  const input = (index: number): CatalogueImportInput => ({ profile: 'work-catalogue-import-v1', expectedWorkHead: null,
    title: `Catalogue common Work ${index}`, language: index % 20 === 0 ? 'ja' : 'en', evidence: 'G1038 catalogue scale fixture',
    aliases: [], semanticTypes: [], credits: [{ agent: actor, role: 'author' }],
    classifications: [{ sense: definitions[index % 10 === 0 ? 1 : 0]!.sense,
      expectedSenseHead: definitions[index % 10 === 0 ? 1 : 0]!.definitionRevision, expectedDecisionHead: null, outcome: 'accepted' }] });
  const grow = async (target: number) => {
    while (works.length < target) {
      signal.throwIfAborted();
      const first = works.length, count = Math.min(128, target - first);
      const rows = await seedCatalogueProfileWorks(api, actor,
        Array.from({ length: count }, (_, offset) => ({ key: `${key}:work:${first + offset}`, input: input(first + offset) })), signal);
      works.push(...rows);
      evidence.completedWorks = works.length; evidence.elapsedMs = performance.now() - started; save();
    }
  };
  const measured = async (name: string, count: number, write: (headers: Headers) => Promise<unknown>) => {
    const before = qaTdbStorage(Bun.env.REZICS_QA_RUN_ID!);
    const { profile } = await profileRequest(sink, write, { service: 'g-1038-scale',
      peers: { fuseki: Bun.env.FUSEKI_URL! }, flush: flushTelemetryTraces });
    const after = qaTdbStorage(Bun.env.REZICS_QA_RUN_ID!);
    const commits = profile.fusekiCalls.reduce((value, call) => value + (call.nativeWork?.durable_commits ?? 0), 0);
    const row = { name, catalogueWorks: works.length, count, latencyMsPerWork: profile.totalLatencyMs / count,
      durableCommits: commits, growth: tdbGrowth(before, after, count),
      profile: Object.fromEntries(Object.entries(profile).filter(([key]) => key !== 'spans')) };
    (evidence.samples as unknown[]).push(row); save(); sink.clear();
    return commits;
  };
  try {
    expect(Bun.env.REZICS_QA_STACK_MODE).toBe('scale');
    await initialize();
    for (let index = 0; index < 8; index++) definitions.push(await api.command(`${key}:topic:${index}`, {
      method: 'POST', path: '/v1/classification-vocabulary', body: { profile: 'classification-proposition-v2',
        scheme: null, labels: [{ value: `Catalogue topic ${index}`, language: 'en' }], alternativeLabels: [], broader: [], narrower: [], actingSubject: actor } }));
    for (const scale of scales) {
      await grow(scale);
      const beforeSingle = qaTdbStorage(Bun.env.REZICS_QA_RUN_ID!);
      const singleProfiles: Awaited<ReturnType<typeof profileRequest>>['profile'][] = [];
      const measuredApi = workProfileCorpusApi('http://main.local', home.author.token, { signal,
        fetch: (async (input, init) => { const response = await home.app.handle(new Request(input, init));
        if (!response.ok) { evidence.lastResponse = await response.clone().text(); save(); } return response; }) as typeof fetch });
      const original = measuredApi.command;
      measuredApi.command = async (commandKey, command, commandSignal) => {
        const { result, profile } = await profileRequest(sink,
          headers => original(commandKey, { ...command, headers }, commandSignal),
          { service: 'g-1038-scale', peers: { fuseki: Bun.env.FUSEKI_URL! }, flush: flushTelemetryTraces });
        singleProfiles.push(profile); sink.clear(); return result;
      };
      const single = await seedPublicProfileWork(measuredApi, `${key}:single:${scale}`, { actingSubject: actor,
        title: `Single catalogue Work ${scale}`, body: 'Selected native text' });
      await measuredApi.command(`${key}:single:${scale}:classification`, { method: 'POST', path: '/v1/classification-decisions',
        body: { profile: 'classification-direct-decision-v1', work: single.work, mainVersion: single.mainVersion,
          context: { kind: 'global' }, sense: definitions[0]!.sense, expectedDecisionHead: null, outcome: 'accepted', actingSubject: actor } });
      const ordinaryCommits = singleProfiles.reduce((sum, profile) => sum + profile.fusekiCalls.reduce((value, call) => value + (call.nativeWork?.durable_commits ?? 0), 0), 0);
      (evidence.samples as unknown[]).push({ name: 'single-publication-work', catalogueWorks: scale, count: 1,
        durableCommits: ordinaryCommits, latencyMsPerWork: singleProfiles.reduce((sum, profile) => sum + profile.totalLatencyMs, 0),
        growth: tdbGrowth(beforeSingle, qaTdbStorage(Bun.env.REZICS_QA_RUN_ID!), 1),
        profiles: singleProfiles.map(profile => Object.fromEntries(Object.entries(profile).filter(([key]) => key !== 'spans'))) });
      save(); expect(ordinaryCommits).toBe(5);
      const compoundCommits = await measured('compound-catalogue-work', 1, async headers => {
        const result = await home.app.handle(new Request('http://main.local/v1/work-imports', { method: 'POST',
          headers: { ...Object.fromEntries(headers), authorization: `Bearer ${home.author.token}`, 'content-type': 'application/json', 'idempotency-key': `${key}:compound:${scale}` },
          body: JSON.stringify({ actingSubject: actor, input: input(scale) }) }));
        expect(result.status, await result.clone().text()).toBe(201);
        return result.json();
      });
      expect(compoundCommits).toBe(1);
      const bulkCommits = await measured('bulk-catalogue-works', 128, async headers => {
        const result = await home.app.handle(new Request('http://main.local/v1/work-imports/bulk', { method: 'POST',
          headers: { ...Object.fromEntries(headers), authorization: `Bearer ${home.author.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ actingSubject: actor, items: Array.from({ length: 128 }, (_, index) => ({ key: `${key}:sample:${scale}:${index}`, input: input(scale + index) })) }) }));
        const body = await home.json<{ complete: boolean; partial: boolean }>(result);
        expect(body).toMatchObject({ complete: true, partial: false });
        return body;
      });
      expect(bulkCommits).toBe(1);
      const first = works[0]!;
      const header = await api.read<{ id: string; revision: string; title: { value: string } }>(`/v1/works/${first.work.slice(-36)}?language=ja&actingSubject=${encodeURIComponent(actor)}`);
      expect(header).toMatchObject({ id: first.work, revision: first.workRevision, title: { value: 'Catalogue common Work 0' } });
      signal.throwIfAborted();
      if (scale < 1000) continue;
      await home.stop(); homeClosed = true;
      const backup = await retainCatalogueBackup(Bun.env.REZICS_QA_RUN_ID!, scale,
        resolve(directory, `corpus-${scale}`), startedAt);
      writeFileSync(resolve(directory, `corpus-${scale}/corpus.json`), JSON.stringify({ scale, definitions, works, backup,
        catalogueWorksIncludingSamples: scale + scales.filter(value => value <= scale).length * 130 }, null, 2), { mode: 0o600 });
      (evidence.backups as unknown[]).push({ scale, backup, preparationMs: Date.now() - startedAt }); save();
      if (scale !== scales.at(-1)) { home = await startHomeStack('g-1038-scale', { projectionStart: 'current' }); homeClosed = false; await initialize(); }
    }
    evidence.status = 'measured requested catalogue scales; stopped backups for scales >=1000; relay backlog retained';
  } catch (error) { evidence.status = 'incomplete'; evidence.failure = String(error); throw error; }
  finally { evidence.elapsedMs = performance.now() - started; save(); if (!homeClosed) await home.stop(); await shutdownTelemetry(); await sink.stop(); }
}, 440_000);

/** Retained command data is verified without rebuilding or replaying its prefix. */
test.skipIf(Bun.env.G1038_REUSE !== '1')('G1038: stopped 1000/10000 catalogues restore isolated exact heads and a ready native index', async () => {
  const { readFileSync } = await import('node:fs');
  const { restoreCatalogueBackup } = await import('../../../scripts/load/catalogue-backup.ts');
  const { FusekiClient } = await import('../../../services/main/src/infrastructure/fuseki.ts');
  for (const scale of [1000,10000]) {
    const corpus = JSON.parse(readFileSync(resolve(`.temp/g-1038/corpus-${scale}/corpus.json`), 'utf8')) as {
      works: { work: string; workRevision: string }[] };
    expect(corpus.works).toHaveLength(scale);
    const restored = await restoreCatalogueBackup(resolve(`.temp/g-1038/corpus-${scale}/backup.json`), `g1038-smoke-${randomUUID().slice(0,8)}`);
    try {
      const client = new FusekiClient(restored.apps.FUSEKI_URL!, restored.apps.FUSEKI_MAINTENANCE_TOKEN, restored.apps.FUSEKI_COMMAND_TOKEN);
      const sample = [...new Set([0,1,Math.floor(scale/2),scale-1])].map(index => corpus.works[index]!);
      const rows = (await client.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?work ?head WHERE {
        VALUES ?work { ${sample.map(row => `<${row.work}>`).join(' ')} }
        GRAPH <urn:rezics:graph:current> { ?work rv:head ?head ; rv:catalogueVisible true }
        GRAPH <urn:rezics:search:public> { ?unit rv:resource ?work ; rv:publicTitle ?title }
      }`,8192)).results!.bindings;
      expect(rows.map(row => [row.work!.value,row.head!.value]).sort()).toEqual(sample.map(row => [row.work,row.workRevision]).sort());
      expect((await client.searchDeltaSince('-1')).available).toBe(true);
      expect(restored.elapsedMs).toBeLessThan(600000);
    } finally { await restored.stop(); }
  }
},120_000);
