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
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';
import { assertWorkCost, profileRequest, startWorkProfileSink } from '../support/work-profile.ts';
import {
  workProfileCorpusApi,
  type CorpusApi,
  type CorpusCommand,
} from '../../../scripts/load/work-profile-corpus.ts';
import { seedPublicProfileWork } from '../../../scripts/load/work-profile-work.ts';
import { seedCatalogueProfileWorks } from '../../../scripts/load/catalogue-work.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE } from '../../../services/main/src/modules/classification/proposition.ts';
import type { CatalogueImportInput } from '../../../services/main/src/modules/work/catalogue-import.ts';
import { RV } from '../../../services/main/src/modules/work/activate.ts';
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
  // catalogue-import loads pg. Import it after telemetry so admission queries are observed.
  const { CATALOGUE_IMPORT_SCOPE } = await import(
    '../../../services/main/src/modules/work/catalogue-import.ts',
  );
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
    classificationCommandsPerAcceptance: 2,
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
      if (command.path === '/v1/statement-decisions') {
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
      ['context:create:root', 'context.create'],
      [`statement:speak:${actor.agent}`, 'statement.record'],
      ['classification:decide:global', 'statement.decide'],
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
    await grantRecordedPlatformUse(stack.accessPool, author.principalId, ['catalogue-import']);
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
    // One shared public interpretation Context, outside every measured cohort.
    // Each acceptance is then two public commands with separate idempotency keys.
    const interpretation = await rawApi.command<{
      profile: string;
      context: string;
      semanticRevision: string;
      component: string;
      revision: string;
      replayed: boolean;
    }>(`${key}:interpretation`, {
      method: 'POST',
      path: '/v1/contexts',
      body: {
        profile: 'context-v1',
        role: 'shared',
        disclosure: 'public',
        base: null,
        entries: [
          {
            target: definition.concept,
            relation: `${RV}classifiedAs`,
            state: 'defined',
            definition: definition.definitionRevision,
            applicability: [],
          },
        ],
        actingSubject: actor.agent,
      },
    });
    expect(interpretation).toMatchObject({ profile: 'context-v1' });
    expect(interpretation.context).toBeString();
    expect(interpretation.semanticRevision).toBeString();
    expect(interpretation.component).toBe(interpretation.context);
    expect(interpretation.revision).toBe(interpretation.semanticRevision);
    expect(interpretation.replayed).toEqual(expect.any(Boolean));
    evidence.interpretation = {
      context: interpretation.context,
      semanticRevision: interpretation.semanticRevision,
    };
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
          concept: definition.concept,
          definition: definition.definitionRevision,
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
      const statementStarted = performance.now(),
        beforeStatementCollection = collectionMs;
      const recorded: { statement: string; meaningKey: string }[] = [];
      for (let offset = 0; offset < cohort; offset++) {
        signal.throwIfAborted();
        profiling = offset === 0;
        const work = works[first + offset]!;
        const statement = await api.command<{
          profile: string;
          statement: string;
          meaningKey: string;
          component: string;
          revision: string;
          sourcePosition: { datasetId: string; dataEpoch: string; sequence: string };
          replayed: boolean;
        }>(`${key}:classification:${scale}:${offset}:statement`, {
          method: 'POST',
          path: '/v1/statements',
          body: {
            profile: 'statement-v1',
            speaker: { kind: 'personal' },
            subject: work.mainVersion,
            predicate: `${RV}classifiedAs`,
            relationDefinition: CLASSIFICATION_PROPOSITION_PROFILE,
            value: { kind: 'resource', iri: definition.concept },
            applicability: [],
            interpretation: {
              kind: 'explicit',
              context: interpretation.context,
              semanticRevision: interpretation.semanticRevision,
            },
            evidence: [],
            actingSubject: actor.agent,
          },
        });
        expect(statement).toMatchObject({
          profile: 'statement-v1',
          sourcePosition: {
            datasetId: 'product',
            dataEpoch: expect.any(String),
            sequence: expect.stringMatching(/^[0-9]+$/),
          },
        });
        expect(statement.statement).toBeString();
        expect(statement.component).toBe(statement.statement);
        expect(statement.meaningKey).toMatch(/^urn:rezics:meaning:[0-9a-f]{64}$/);
        expect(statement.revision).toBeString();
        expect(statement.replayed).toEqual(expect.any(Boolean));
        recorded[offset] = statement;
      }
      profiling = false;
      const statementMs =
        performance.now() - statementStarted - (collectionMs - beforeStatementCollection);
      const afterStatements = qaTdbStorage(Bun.env.REZICS_QA_RUN_ID!);
      const decisionStarted = performance.now(),
        beforeDecisionCollection = collectionMs;
      const decisions: { slot: string; decision: string }[] = [];
      for (let offset = 0; offset < cohort; offset++) {
        signal.throwIfAborted();
        profiling = offset === 0;
        const statement = recorded[offset]!;
        const decision = await api.command<{
          profile: string;
          outcome: string;
          slot: string;
          decision: string;
          component: string;
          revision: string;
          sourcePosition: { datasetId: string; dataEpoch: string; sequence: string };
          replayed: boolean;
        }>(`${key}:classification:${scale}:${offset}:decision`, {
          method: 'POST',
          path: '/v1/statement-decisions',
          body: {
            profile: 'statement-decision-v1',
            target: {
              kind: 'qualified-fact',
              meaningKey: statement.meaningKey,
              support: [statement.statement],
            },
            acceptance: { kind: 'global' },
            expectedDecisionHead: null,
            outcome: 'accepted',
            actingSubject: actor.agent,
          },
        });
        expect(decision).toMatchObject({
          profile: 'statement-decision-v1',
          outcome: 'accepted',
          sourcePosition: {
            datasetId: 'product',
            dataEpoch: expect.any(String),
            sequence: expect.stringMatching(/^[0-9]+$/),
          },
        });
        expect(decision.slot).toBeString();
        expect(decision.decision).toBeString();
        expect(decision.component).toBe(decision.slot);
        expect(decision.revision).toBe(decision.decision);
        expect(decision.replayed).toEqual(expect.any(Boolean));
        expect(decision).not.toHaveProperty('decisionOutcome');
        expect(decision).not.toHaveProperty('work');
        expect(decision).not.toHaveProperty('sense');
        decisions[offset] = decision;
      }
      profiling = false;
      const decisionMs =
        performance.now() - decisionStarted - (collectionMs - beforeDecisionCollection);
      const classificationMs = statementMs + decisionMs;
      const afterClassification = qaTdbStorage(Bun.env.REZICS_QA_RUN_ID!);
      expect(
        profiles
          .slice(beforeProfiles)
          .map((item) => item.path)
          .filter((path) => path === '/v1/statements' || path === '/v1/statement-decisions'),
      ).toEqual(['/v1/statements', '/v1/statement-decisions']);
      const classificationRelayStarted = performance.now();
      await home.projectRelay();
      const classificationRelayMs = performance.now() - classificationRelayStarted;
      const sample = {
        catalogueWorksBefore: scale,
        completedWorks: works.length,
        workCohortMs: workMs,
        workWallMsPerWrite: workMs / cohort,
        workRelayMs: relayMs - beforeRelay,
        classificationCommandsPerAcceptance: 2,
        statementCohortMs: statementMs,
        statementWallMsPerCommand: statementMs / cohort,
        decisionCohortMs: decisionMs,
        decisionWallMsPerCommand: decisionMs / cohort,
        classificationCohortMs: classificationMs,
        classificationWallMsPerWrite: classificationMs / cohort,
        classificationRelayMs,
        workGrowth: tdbGrowth(beforeWork, afterWork, cohort),
        statementGrowth: tdbGrowth(afterWork, afterStatements, cohort),
        decisionGrowth: tdbGrowth(afterStatements, afterClassification, cohort),
        classificationGrowth: tdbGrowth(afterWork, afterClassification, cohort),
        beforeWork,
        afterWork,
        afterStatements,
        afterClassification,
        profiles: profiles.slice(beforeProfiles),
      };
      (evidence.samples as unknown[]).push(sample);
      const accepted = works[first]!;
      const resolved = await rawApi.command<{
        state: string;
        source: string;
        decision: string | null;
        work: string;
        sense: string;
      }>(`${key}:classification:${scale}:resolution`, {
        method: 'POST',
        path: '/v1/classification-resolutions',
        body: {
          profile: 'classification-resolution-v1',
          context: { kind: 'global' },
          work: accepted.work,
          mainVersion: accepted.mainVersion,
          sense: definition.sense,
        },
      });
      expect(resolved).toMatchObject({
        state: 'accepted',
        source: 'global',
        work: accepted.work,
        sense: definition.sense,
        decision: decisions[0]!.decision,
      });
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
