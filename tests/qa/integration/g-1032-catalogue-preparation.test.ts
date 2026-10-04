import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startHomeStack } from './feed-read-support.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { workProfileCorpusApi } from '../../../scripts/load/work-profile-corpus.ts';
import { CATALOGUE_IMPORT_SCOPE } from '../../../services/main/src/modules/work/catalogue-import.ts';
import { seedQueryCatalogue, QUERY_CATALOGUE_SCALES } from '../../../scripts/load/corpus-query.ts';
import { scalePreparationBudgetMs } from '../../../scripts/qa/stack-environment.ts';

/** Explicit preparation probe: never silently substitute a storage-seeded
 * catalogue or call extrapolated scales measured. Full preparation/restore has
 * a 600s ceiling; the integration runner leaves 120s for stack/cleanup. */
test(
  'G1032: public command preparation reaches the first 1000-Work catalogue scale',
  async () => {
    const started = performance.now();
    const home = await startHomeStack('g-1032-catalogue');
    const { stack, author } = home;
    let completed = 0,
      commands = 0;
    const buildDeadlineMs = scalePreparationBudgetMs(Number(Bun.env.REZICS_QA_PREPARATION_STARTED_AT));
    const deadline = AbortSignal.timeout(buildDeadlineMs);
    const evidence: Record<string, unknown> = {
      requestedScales: QUERY_CATALOGUE_SCALES,
      buildDeadlineMs,
      totalPreparationDeadlineMs: 600_000,
      batchSize: 128,
      preparation: 'public bulk catalogue import and classification vocabulary APIs',
      backup: null,
      restore: null,
    };
    try {
      const app = createMainApp(stack.fuseki, home.deps);
      const api = workProfileCorpusApi('http://main.local', author.token, {
        signal: deadline,
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          deadline.throwIfAborted();
          commands++;
          let response: Response;
          for (let attempt = 0; ; attempt++) {
            deadline.throwIfAborted();
            response = await app.handle(new Request(input, init));
            if (response.status !== 202 || attempt === 3) break;
            const pending = (await response.clone().json()) as {
              retry?: { allowed?: boolean; afterMs?: number };
            };
            if (
              pending.retry?.allowed !== true ||
              !Number.isSafeInteger(pending.retry.afterMs) ||
              pending.retry.afterMs! < 0 ||
              pending.retry.afterMs! > 1000
            )
              break;
            // The public result explicitly allows an idempotent retry. Replay
            // the exact body/key and debit the same preparation wall budget.
            evidence.pendingRetries = Number(evidence.pendingRetries ?? 0) + 1;
            await delay(pending.retry.afterMs!, undefined, { signal: deadline });
            commands++;
          }
          if (![200, 201, 204].includes(response.status)) {
            evidence.lastCommandError = await response.clone().text();
            evidence.lastCommandStatus = response.status;
            evidence.lastCommandPath = new URL(
              input instanceof Request ? input.url : input,
            ).pathname;
          }
          return response;
        }) as typeof fetch,
      });
      const actor = await api.command<{ agent: string }>('g-1032:catalogue:author', {
        method: 'POST',
        path: '/v1/agents',
        body: {
          profile: 'agent-provision-v1',
          kind: 'person',
          displayName: 'Query catalogue author',
        },
      });
      // Classification authority is fixture preparation, never a timed query.
      for (const [action, scope] of [['classification.proposition.define', 'classification:define:global'],
        ['classification.decision.set', 'classification:decide:global'], ['work.create', CATALOGUE_IMPORT_SCOPE]]) {
        await stack.accessPool.query(
          `INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING`,
          [scope],
        );
        await stack.accessPool.query(
          `INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`,
          [crypto.randomUUID(), author.principalId, actor.agent, action],
        );
        await stack.accessPool.query(
          `INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`,
          [crypto.randomUUID(), actor.agent, scope, action],
        );
      }
      const first = QUERY_CATALOGUE_SCALES[0];
      const corpus = await seedQueryCatalogue({
        api,
        actingSubject: actor.agent,
        key: 'g-1032:catalogue',
        ...first,
        signal: deadline,
        settle: home.projectRelay,
        progress: (count) => {
          completed = count;
          writeFileSync(
            join(Bun.env.REZICS_QA_ARTIFACT_DIR!, 'g-1032-catalogue-progress.json'),
            JSON.stringify({ completed, commands, elapsedMs: performance.now() - started }),
          );
        },
      });
      completed = corpus.works.length;
      expect(corpus.works).toHaveLength(first.works);
      expect(corpus.definitions).toHaveLength(first.vocabulary);
      evidence.status =
        'command-build-complete; stopped backup, isolated restore and query scales still unqualified';
    } catch (error) {
      evidence.status = 'blocked';
      evidence.failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw error;
    } finally {
      evidence.completedCheckpointWorks = completed;
      evidence.commands = commands;
      evidence.elapsedMs = performance.now() - started;
      writeFileSync(
        join(Bun.env.REZICS_QA_ARTIFACT_DIR!, 'g-1032-catalogue-preparation.json'),
        JSON.stringify(evidence, null, 2),
      );
      await home.stop();
    }
  },
  420_000,
);
