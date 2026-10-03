import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startTelemetry, flushTelemetryTraces, shutdownTelemetry } from '@rezics/observability/runtime';
import { assertWorkCost, profileRequest, startWorkProfileSink } from '../support/work-profile.ts';
import { workProfileCorpusApi, type CorpusApi, type CorpusCommand } from '../../../scripts/load/work-profile-corpus.ts';
import { seedPublicProfileWork } from '../../../scripts/load/work-profile-work.ts';
import { runBoundedIndices } from '../../../scripts/load/schedule.ts';
import { qaTdbStorage, tdbGrowth } from '../../../scripts/load/tdb-growth.ts';
import { scalePreparationBudgetMs } from '../../../scripts/qa/stack-environment.ts';

/** Public command preparation has a hard wall budget. Opt in to the catalogue
 * scales with G1031_SCALES=100,1000,10000; never replace an unfinished scale
 * with raw storage rows or turn a throughput estimate into measured capacity. */
test('G1031: disk-backed catalogue exposes public Work/classification write cost and storage growth', async () => {
  const scales = (Bun.env.G1031_SCALES ?? '100').split(',').map(Number);
  if (scales.some((scale, index) => ![100, 1000, 10000].includes(scale)
    || scale <= (scales[index - 1] ?? 0))) throw new Error('Invalid G1031_SCALES');
  const sink = startWorkProfileSink({ settleMs: 25 });
  // Unparented preparation spans need not fill the sink. Every measured request
  // explicitly supplies a sampled parent, overriding the root sample ratio.
  startTelemetry('g-1031-write', { ...process.env, ...sink.env, OTEL_TRACES_SAMPLER_ARG: '0' });
  const { startHomeStack } = await import('./feed-read-support.ts');
  const { createMainApp } = await import('../../../services/main/src/app.ts');
  const started = performance.now();
  const buildBudgetMs = scalePreparationBudgetMs(Number(Bun.env.REZICS_QA_PREPARATION_STARTED_AT));
  const signal = AbortSignal.timeout(buildBudgetMs);
  const directory = resolve('.temp/g-1031');
  mkdirSync(directory, { recursive: true });
  const evidence: Record<string, unknown> = {
    qaRunId: Bun.env.REZICS_QA_RUN_ID,
    scales, stackMode: Bun.env.REZICS_QA_STACK_MODE, buildBudgetMs,
    totalPreparationBudgetMs: 600_000, workers: 2,
    backup: null, restore: null, samples: [],
    unobserved: ['native validation/indexing/commit phase times', 'physical SQL plan rows'],
  };
  const save = () => writeFileSync(resolve(directory, 'catalogue-write.json'), JSON.stringify(evidence, null, 2));
  const home = await startHomeStack('g-1031-write');
  const { stack, author } = home;
  const works: Awaited<ReturnType<typeof seedPublicProfileWork>>[] = [];
  let commands = 0, pendingRetries = 0, profiling = false, collectionMs = 0;
  let relayMs = 0;
  const profiles: Record<string, unknown>[] = [];
  evidence.profiles = profiles;
  const key = `g1031:${randomUUID()}`;
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
      const pending = await response.clone().json() as { retry?: { allowed?: boolean; afterMs?: number } };
      if (pending.retry?.allowed !== true || !Number.isSafeInteger(pending.retry.afterMs)
        || pending.retry.afterMs! < 0 || pending.retry.afterMs! > 1000) return response;
      pendingRetries++;
      await delay(pending.retry.afterMs!, undefined, { signal });
    }
  }) as typeof fetch;
  const rawApi = workProfileCorpusApi('http://main.local', author.token, { signal, fetch: commandFetch });
  const api: CorpusApi = {
    read: rawApi.read,
    async command<T>(commandKey: string, command: CorpusCommand, commandSignal?: AbortSignal): Promise<T> {
      if (!profiling) return rawApi.command(commandKey, command, commandSignal);
      const collectStarted = performance.now();
      const { result, profile } = await profileRequest(sink, headers => {
        const merged = new Headers(command.headers);
        for (const [name, value] of headers) merged.set(name, value);
        return rawApi.command<T>(commandKey, { ...command, headers: merged }, commandSignal);
      }, { service: 'g-1031-write', peers: { fuseki: Bun.env.FUSEKI_URL! }, flush: flushTelemetryTraces });
      collectionMs += performance.now() - collectStarted - profile.totalLatencyMs;
      expect(profile.postgresStatements).toBeGreaterThan(0);
      expect(profile.fusekiRequests).toBeGreaterThan(0);
      assertWorkCost(profile, { fusekiRequests: 64, postgresStatements: 400, accountCalls: 0 });
      profiles.push({ path: command.path, profile });
      save();
      sink.clear();
      return result;
    },
  };
  try {
    expect(Bun.env.REZICS_QA_STACK_MODE).toBe('scale');
    evidence.initialStorage = qaTdbStorage(Bun.env.REZICS_QA_RUN_ID!);
    const actor = await api.command<{ agent: string }>(`${key}:author`, { method: 'POST', path: '/v1/agents',
      body: { profile: 'agent-provision-v1', kind: 'person', displayName: 'Catalogue write author' } });
    for (const [scope, action] of [['classification:define:global', 'classification.proposition.define'],
      ['classification:decide:global', 'classification.decision.set']]) {
      await stack.accessPool.query('INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await stack.accessPool.query(`INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), author.principalId, actor.agent, action]);
      await stack.accessPool.query(`INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), actor.agent, scope, action]);
    }
    const definition = await api.command<{ concept: string; sense: string }>(`${key}:topic`, {
      method: 'POST', path: '/v1/classification-vocabulary', body: {
        profile: 'classification-proposition-v2', scheme: null,
        labels: [{ language: 'en', value: 'Write cost topic' }], alternativeLabels: [], broader: [], narrower: [],
        actingSubject: actor.agent,
      },
    });
    const seed = async (index: number) => {
      signal.throwIfAborted();
      works[index] = await seedPublicProfileWork(api, `${key}:work:${index}`, {
        actingSubject: actor.agent, title: `Catalogue common Work ${index}`, body: `Catalogue selected text ${index}`,
      });
    };
    const grow = async (target: number) => {
      while (works.length < target) {
        const first = works.length;
        await runBoundedIndices(Math.min(32, target - first), 2, offset => seed(first + offset), () => {});
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
      const first = works.length, beforeProfiles = profiles.length;
      const beforeRelay = relayMs;
      const cohortStarted = performance.now(), beforeCollection = collectionMs;
      profiling = true;
      await seed(first);
      profiling = false;
      await grow(first + 32);
      const workMs = performance.now() - cohortStarted - (collectionMs - beforeCollection);
      const afterWork = qaTdbStorage(Bun.env.REZICS_QA_RUN_ID!);
      const classifyStarted = performance.now(), beforeClassificationCollection = collectionMs;
      for (let offset = 0; offset < 32; offset++) {
        signal.throwIfAborted();
        profiling = offset === 0;
        const work = works[first + offset]!;
        const receipt = await api.command<{ decision: string; decisionOutcome: string; work: string; sense: string }>(`${key}:classification:${scale}:${offset}`, {
          method: 'POST', path: '/v1/classification-decisions', body: {
            profile: 'classification-direct-decision-v1', context: { kind: 'global' },
            work: work.work, mainVersion: work.mainVersion, sense: definition.sense,
            expectedDecisionHead: null, outcome: 'accepted', actingSubject: actor.agent,
          },
        });
        expect(receipt).toMatchObject({ decisionOutcome: 'accepted', work: work.work, sense: definition.sense });
        expect(receipt.decision).toBeString();
      }
      profiling = false;
      const classificationMs = performance.now() - classifyStarted - (collectionMs - beforeClassificationCollection);
      const afterClassification = qaTdbStorage(Bun.env.REZICS_QA_RUN_ID!);
      const classificationRelayStarted = performance.now();
      await home.projectRelay();
      const classificationRelayMs = performance.now() - classificationRelayStarted;
      const sample = { catalogueWorksBefore: scale, completedWorks: works.length,
        workCohortMs: workMs, workWallMsPerWrite: workMs / 32,
        workRelayMs: relayMs - beforeRelay,
        classificationCohortMs: classificationMs, classificationWallMsPerWrite: classificationMs / 32,
        classificationRelayMs,
        workGrowth: tdbGrowth(beforeWork, afterWork, 32),
        classificationGrowth: tdbGrowth(afterWork, afterClassification, 32),
        beforeWork, afterWork, afterClassification, profiles: profiles.slice(beforeProfiles) };
      (evidence.samples as unknown[]).push(sample);
      const work = works[first]!;
      const selected = await api.read<{ contribution: string; selectedDraft: string; body: string }>(
        `/v1/main-versions/${work.mainVersion.slice(-36)}/selection?language=en`);
      expect(selected).toMatchObject({ contribution: work.contribution, selectedDraft: work.draftRevision,
        body: `Catalogue selected text ${first}` });
      evidence.elapsedMs = performance.now() - started;
      save();
    }
    evidence.status = 'measured requested write scales; backup/restore and query matrix unqualified';
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
