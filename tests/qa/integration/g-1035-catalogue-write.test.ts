import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  startTelemetry,
  flushTelemetryTraces,
  shutdownTelemetry,
} from '@rezics/observability/runtime';
import { assertWorkCost, profileRequest, startWorkProfileSink } from '../support/work-profile.ts';
import {
  workProfileCorpusApi,
  type CorpusApi,
  type CorpusCommand,
} from '../../../scripts/load/work-profile-corpus.ts';
import { seedPublicProfileWork } from '../../../scripts/load/work-profile-work.ts';
import { seedCatalogueProfileWorks } from '../../../scripts/load/catalogue-work.ts';
import {
  CATALOGUE_IMPORT_SCOPE,
  type CatalogueImportInput,
} from '../../../services/main/src/modules/work/catalogue-import.ts';
import { qaTdbStorage, tdbGrowth } from '../../../scripts/load/tdb-growth.ts';
import { scalePreparationBudgetMs } from '../../../scripts/qa/stack-environment.ts';

/** Public command preparation has a hard wall budget. Opt in to the catalogue
 * scales with G1035_SCALES=100,1000,10000; never replace an unfinished scale
 * with raw storage rows or turn a throughput estimate into measured capacity. */
test('G1035: disk-backed catalogue exposes public Work/classification write cost and storage growth', async () => {
  const scales = (Bun.env.G1035_SCALES ?? '100').split(',').map(Number);
  const cohort = Number(Bun.env.G1035_COHORT ?? '4');
  if (![4, 8, 32].includes(cohort)) throw new Error('Invalid G1035_COHORT');
  if (
    scales.some(
      (scale, index) => ![8, 100, 1000, 10000].includes(scale) || scale <= (scales[index - 1] ?? 0),
    )
  )
    throw new Error('Invalid G1035_SCALES');
  const sink = startWorkProfileSink({ settleMs: 25 });
  // Unparented preparation spans need not fill the sink. Every measured request
  // explicitly supplies a sampled parent, overriding the root sample ratio.
  startTelemetry('g-1035-write', { ...process.env, ...sink.env, OTEL_TRACES_SAMPLER_ARG: '0' });
  const { startHomeStack } = await import('./feed-read-support.ts');
  const { createMainApp } = await import('../../../services/main/src/app.ts');
  const started = performance.now();
  const buildBudgetMs = scalePreparationBudgetMs(Number(Bun.env.REZICS_QA_PREPARATION_STARTED_AT));
  const signal = AbortSignal.timeout(buildBudgetMs);
  const directory = resolve('.temp/g-1035');
  mkdirSync(directory, { recursive: true });
  const evidence: Record<string, unknown> = {
    qaRunId: Bun.env.REZICS_QA_RUN_ID,
    scales,
    stackMode: Bun.env.REZICS_QA_STACK_MODE,
    buildBudgetMs,
    totalPreparationBudgetMs: 600_000,
    batchSize: 128,
    writeCohort: cohort,
    backup: null,
    restore: null,
    samples: [],
    unobserved: ['physical SQL plan rows', 'native index pages modified'],
  };
  const save = () =>
    writeFileSync(
      resolve(directory, `catalogue-write-${Bun.env.G1035_LABEL ?? 'diagnostic'}.json`),
      JSON.stringify(evidence, null, 2),
    );
  const home = await startHomeStack('g-1035-write');
  const { stack, author } = home;
  const works: { work: string; mainVersion: string }[] = [];
  let commands = 0,
    pendingRetries = 0,
    profiling = false,
    collectionMs = 0;
  let relayMs = 0;
  const profiles: Record<string, unknown>[] = [];
  evidence.profiles = profiles;
  const key = `g1035:${randomUUID()}`;
  const app = createMainApp(stack.fuseki, home.deps);
  const commandFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      commands++;
      const response = await app.handle(new Request(input, init));
      if (response.status !== 202 || attempt === 3) {
        if (![200, 201, 204].includes(response.status)) {
          evidence.lastCommandError = await response.clone().text();
          evidence.lastCommandPath = new URL(input instanceof Request ? input.url : input).pathname;
        }
        return response;
      }
      const pending = (await response.clone().json()) as {
        retry?: { allowed?: boolean; afterMs?: number };
      };
      if (
        pending.retry?.allowed !== true ||
        !Number.isSafeInteger(pending.retry.afterMs) ||
        pending.retry.afterMs! < 0 ||
        pending.retry.afterMs! > 1000
      )
        return response;
      pendingRetries++;
      await delay(pending.retry.afterMs!, undefined, { signal });
    }
  }) as typeof fetch;
  const rawApi = workProfileCorpusApi('http://main.local', author.token, {
    signal,
    fetch: commandFetch,
  });
  const api: CorpusApi = {
    read: rawApi.read,
    async command<T>(
      commandKey: string,
      command: CorpusCommand,
      commandSignal?: AbortSignal,
    ): Promise<T> {
      if (!profiling) return rawApi.command(commandKey, command, commandSignal);
      const collectStarted = performance.now();
      const { result, profile } = await profileRequest(
        sink,
        (headers) => {
          const merged = new Headers(command.headers);
          for (const [name, value] of headers) merged.set(name, value);
          return rawApi.command<T>(commandKey, { ...command, headers: merged }, commandSignal);
        },
        {
          service: 'g-1035-write',
          peers: { fuseki: Bun.env.FUSEKI_URL! },
          flush: flushTelemetryTraces,
        },
      );
      collectionMs += performance.now() - collectStarted - profile.totalLatencyMs;
      expect(profile.postgresStatements).toBeGreaterThan(0);
      expect(profile.fusekiRequests).toBeGreaterThan(0);
      assertWorkCost(profile, { fusekiRequests: 64, postgresStatements: 400, accountCalls: 0 });
      const native = profile.spans.filter(
        (span) => span.attributes['rezics.fuseki.commit_ms'] !== undefined,
      );
      expect(native).toHaveLength(1);
      expect(native[0]!.attributes['rezics.fuseki.validation_ms']).toBeGreaterThan(0);
      if (command.path === '/v1/classification-decisions') {
        expect(native[0]!.attributes['rezics.fuseki.text_adds']).toBe(0);
        expect(native[0]!.attributes['rezics.fuseki.text_updates']).toBe(0);
        expect(native[0]!.attributes['rezics.fuseki.text_deletes']).toBe(0);
      }
      profiles.push({ path: command.path, profile, native: native.map((span) => span.attributes) });
      save();
      sink.clear();
      return result;
    },
  };
  try {
    expect(Bun.env.REZICS_QA_STACK_MODE).toBe('scale');
    evidence.initialStorage = qaTdbStorage(Bun.env.REZICS_QA_RUN_ID!);
    const actor = await api.command<{ agent: string }>(`${key}:author`, {
      method: 'POST',
      path: '/v1/agents',
      body: {
        profile: 'agent-provision-v1',
        kind: 'person',
        displayName: 'Catalogue write author',
      },
    });
    for (const [scope, action] of [
      [CATALOGUE_IMPORT_SCOPE, 'work.create'],
      ['classification:define:global', 'classification.proposition.define'],
      ['classification:decide:global', 'classification.decision.set'],
    ]) {
      await stack.accessPool.query(
        'INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING',
        [scope],
      );
      await stack.accessPool.query(
        `INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`,
        [randomUUID(), author.principalId, actor.agent, action],
      );
      await stack.accessPool.query(
        `INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`,
        [randomUUID(), actor.agent, scope, action],
      );
    }
    const definition = await api.command<{
      concept: string;
      sense: string;
      definitionRevision: string;
    }>(`${key}:topic`, {
      method: 'POST',
      path: '/v1/classification-vocabulary',
      body: {
        profile: 'classification-proposition-v2',
        scheme: null,
        labels: [{ language: 'en', value: 'Write cost topic' }],
        alternativeLabels: [],
        broader: [],
        narrower: [],
        actingSubject: actor.agent,
      },
    });
    const seed = async (index: number) => {
      signal.throwIfAborted();
      const work = await seedPublicProfileWork(api, `${key}:work:${index}`, {
        actingSubject: actor.agent,
        title: `Catalogue common Work ${index}`,
        body: `Catalogue selected text ${index}`,
      });
      works[index] = work;
      return work;
    };
    const catalogueInput = (index: number): CatalogueImportInput => ({
      profile: 'work-catalogue-import-v1',
      expectedWorkHead: null,
      title: `Catalogue common Work ${index}`,
      language: 'en',
      evidence: 'G1035 public catalogue preparation',
      aliases: [],
      semanticTypes: [],
      credits: [{ agent: actor.agent, role: 'author' }],
      classifications: [
        {
          sense: definition.sense,
          expectedSenseHead: definition.definitionRevision,
          expectedDecisionHead: null,
          outcome: 'accepted',
        },
      ],
    });
    const grow = async (target: number) => {
      while (works.length < target) {
        const first = works.length;
        const rows = await seedCatalogueProfileWorks(
          rawApi,
          actor.agent,
          Array.from({ length: Math.min(128, target - first) }, (_, offset) => ({
            key: `${key}:background:${first + offset}`,
            input: catalogueInput(first + offset),
          })),
          signal,
        );
        works.push(...rows);
        const relayStarted = performance.now();
        await home.projectRelay();
        relayMs += performance.now() - relayStarted;
        evidence.completedWorks = works.length;
        evidence.commands = commands;
        evidence.elapsedMs = performance.now() - started;
        save();
      }
    };
    for (const scale of scales) {
      await grow(scale);
      const beforeWork = qaTdbStorage(Bun.env.REZICS_QA_RUN_ID!);
      const first = works.length,
        beforeProfiles = profiles.length;
      const beforeRelay = relayMs;
      const cohortStarted = performance.now(),
        beforeCollection = collectionMs;
      profiling = true;
      const selectedWork = await seed(first);
      profiling = false;
      for (let offset = 1; offset < cohort; offset++) await seed(first + offset);
      const workRelayStarted = performance.now();
      await home.projectRelay();
      relayMs += performance.now() - workRelayStarted;
      const workMs = performance.now() - cohortStarted - (collectionMs - beforeCollection);
      const afterWork = qaTdbStorage(Bun.env.REZICS_QA_RUN_ID!);
      const classifyStarted = performance.now(),
        beforeClassificationCollection = collectionMs;
      for (let offset = 0; offset < cohort; offset++) {
        signal.throwIfAborted();
        profiling = offset === 0;
        const work = works[first + offset]!;
        const receipt = await api.command<{
          decision: string;
          decisionOutcome: string;
          work: string;
          sense: string;
        }>(`${key}:classification:${scale}:${offset}`, {
          method: 'POST',
          path: '/v1/classification-decisions',
          body: {
            profile: 'classification-direct-decision-v1',
            context: { kind: 'global' },
            work: work.work,
            mainVersion: work.mainVersion,
            sense: definition.sense,
            expectedDecisionHead: null,
            outcome: 'accepted',
            actingSubject: actor.agent,
          },
        });
        expect(receipt).toMatchObject({
          decisionOutcome: 'accepted',
          work: work.work,
          sense: definition.sense,
        });
        expect(receipt.decision).toBeString();
      }
      profiling = false;
      const classificationMs =
        performance.now() - classifyStarted - (collectionMs - beforeClassificationCollection);
      const afterClassification = qaTdbStorage(Bun.env.REZICS_QA_RUN_ID!);
      const classificationRelayStarted = performance.now();
      await home.projectRelay();
      const classificationRelayMs = performance.now() - classificationRelayStarted;
      const sample = {
        catalogueWorksBefore: scale,
        completedWorks: works.length,
        workCohortMs: workMs,
        workWallMsPerWrite: workMs / cohort,
        workRelayMs: relayMs - beforeRelay,
        classificationCohortMs: classificationMs,
        classificationWallMsPerWrite: classificationMs / cohort,
        classificationRelayMs,
        workGrowth: tdbGrowth(beforeWork, afterWork, cohort),
        classificationGrowth: tdbGrowth(afterWork, afterClassification, cohort),
        beforeWork,
        afterWork,
        afterClassification,
        profiles: profiles.slice(beforeProfiles),
      };
      (evidence.samples as unknown[]).push(sample);
      const work = selectedWork;
      const selected = await api.read<{
        contribution: string;
        selectedDraft: string;
        body: string;
      }>(`/v1/main-versions/${work.mainVersion.slice(-36)}/selection?language=en`);
      expect(selected).toMatchObject({
        contribution: work.contribution,
        selectedDraft: work.draftRevision,
        body: `Catalogue selected text ${first}`,
      });
      for (const [name, count] of [
        ['compound', 1],
        ['bulk', cohort],
      ] as const) {
        const before = qaTdbStorage(Bun.env.REZICS_QA_RUN_ID!);
        const items = Array.from({ length: count }, (_, offset) => ({
          key: `${key}:${name}:${scale}:${offset}`,
          input: catalogueInput(works.length + offset),
        }));
        const { profile } = await profileRequest(
          sink,
          async (headers) => {
            const measuredApi = {
              ...rawApi,
              command: <T>(
                commandKey: string,
                command: CorpusCommand,
                commandSignal?: AbortSignal,
              ) => rawApi.command<T>(commandKey, { ...command, headers }, commandSignal),
            };
            if (name === 'bulk') {
              works.push(
                ...(await seedCatalogueProfileWorks(measuredApi, actor.agent, items, signal)),
              );
            } else {
              const result = await measuredApi.command<{
                receipt: { outcome: string; work: string; mainVersion: string };
              }>(
                items[0]!.key,
                {
                  method: 'POST',
                  path: '/v1/work-imports',
                  body: { actingSubject: actor.agent, input: items[0]!.input },
                },
                signal,
              );
              expect(result.receipt.outcome).toBe('succeeded');
              works.push(result.receipt);
            }
          },
          {
            service: 'g-1035-write',
            peers: { fuseki: Bun.env.FUSEKI_URL! },
            flush: flushTelemetryTraces,
          },
        );
        expect(profile.postgresStatements).toBeGreaterThan(0);
        expect(profile.fusekiRequests).toBeGreaterThan(0);
        assertWorkCost(profile, {
          fusekiRequests: 64,
          postgresStatements: 400 * count,
          accountCalls: 0,
        });
        const commits = profile.fusekiCalls.reduce(
          (sum, call) => sum + (call.nativeWork?.durable_commits ?? 0),
          0,
        );
        expect(commits).toBe(1);
        (evidence.samples as unknown[]).push({
          name,
          catalogueScale: scale,
          catalogueWorksBefore: works.length - count,
          count,
          profile,
          growth: tdbGrowth(before, qaTdbStorage(Bun.env.REZICS_QA_RUN_ID!), count),
        });
        sink.clear();
        await home.projectRelay();
      }
      evidence.elapsedMs = performance.now() - started;
      save();
    }
    evidence.status =
      'measured requested write scales; backup/restore and query matrix unqualified';
  } catch (error) {
    evidence.status = 'incomplete';
    evidence.failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw error;
  } finally {
    evidence.completedWorks = works.filter(Boolean).length;
    evidence.commands = commands;
    evidence.pendingRetries = pendingRetries;
    evidence.workPreparationRelayMs = relayMs;
    evidence.elapsedMs = performance.now() - started;
    save();
    await home.stop();
    await shutdownTelemetry();
    await sink.stop();
  }
}, 440_000);
