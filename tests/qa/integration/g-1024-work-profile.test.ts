import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { initializeRelayCheckpoint } from '../../../services/main/src/modules/outbox/relay.ts';
import { workProfileProbe } from '../support/work-profile-probe.ts';
import { assertWorkCost } from '../support/work-profile.ts';
import { captureFusekiQueryPlan } from '../../../scripts/load/fuseki-plan.ts';
import { startFusekiMeter } from '../../../scripts/load/measurement.ts';
import { seedPublicProfileWork } from '../../../scripts/load/work-profile-work.ts';
import {
  workProfileCorpusApi,
  workProfileDimensions,
  WORK_PROFILE_SCALES,
  type CorpusDimensions,
} from '../../../scripts/load/work-profile-corpus.ts';
import { runBoundedIndices } from '../../../scripts/load/schedule.ts';
import { fusekiCandidateCounts } from '../../../scripts/load/fuseki-candidates.ts';
import { PUBLIC_SEARCH_GRAPH } from '../../../services/main/src/modules/work/select-main.ts';
import { startMediaStack } from './media-support.ts';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

test('G1024: request counters detect real Fuseki and PostgreSQL work on the isolated QA stack', async () => {
  if (!process.env.REZICS_QA_RUN_ID || !process.env.FUSEKI_URL || !process.env.ACCESS_DATABASE_URL)
    throw new Error('Run this file through goalctl test');
  const evidence = [];
  for (const loops of [1, 4, 9]) {
    const { result, profile } = await workProfileProbe(loops, true);
    expect(result.rows).toEqual(Array.from({ length: loops }, () => '1'));
    expect(profile.fusekiRequests).toBe(loops);
    expect(profile.postgresStatements).toBe(loops);
    expect(profile.fusekiReceivedBytes).toBeGreaterThan(0);
    expect(profile.fusekiSentBytes).toBeGreaterThan(0);
    assertWorkCost(profile, { fusekiRequests: loops, postgresStatements: loops, accountCalls: 1 });
    if (loops > 3)
      expect(() => assertWorkCost(profile, { fusekiRequests: 3, postgresStatements: 3 })).toThrow();
    // A producer may add the native timer later; missing timing cannot impersonate HTTP latency.
    if (profile.fusekiEngineMs === null)
      expect(profile.unobserved).toContain('rezics.fuseki.engine_ms');
    else expect(profile.fusekiEngineMs).toBeGreaterThanOrEqual(0);
    evidence.push({ loops, profile });
  }
  mkdirSync('.temp/work-profiles', { recursive: true });
  writeFileSync(
    '.temp/work-profiles/g-1024-calibration.json',
    JSON.stringify(evidence, null, 2) + '\n',
  );
}, 60_000);

test('G1024: captured query produces a real pinned ARQ plan and candidate count without reopening live TDB2', async () => {
  const directory = resolve('.temp/work-profiles/qa-plans');
  const meter = startFusekiMeter(process.env.FUSEKI_URL!);
  try {
    meter.beginCapture();
    const response = await fetch(`${meter.url}query`, {
      method: 'POST',
      headers: {
        'content-type': 'application/sparql-query',
        accept: 'application/sparql-results+json',
      },
      body: 'SELECT (COUNT(*) AS ?candidateCount) WHERE { VALUES ?value { 1 2 3 4 5 6 7 8 9 } }',
    });
    expect(response.status).toBe(200);
    await response.json();
    const captured = meter.endCapture();
    expect(captured).toHaveLength(1);
    const plan = captureFusekiQueryPlan(captured[0]!, {
      label: 'g-1024-calibration',
      directory,
    });
    expect(plan.bytes).toBeGreaterThan(0);
    expect(readFileSync(join(directory, plan.planFile), 'utf8')).toContain('table');
    expect(plan.basis).toContain('not runtime');
    expect(plan.candidates.counts).toEqual([9]);
    expect(plan.candidates.returnedBindings).toBe(1);
  } finally {
    await meter.stop();
  }
}, 45_000);

test('G1024: three corpus Work scales use real public commands and preserve exact selected content within the preparation budget', async () => {
  const started = performance.now();
  const stack = await startMediaStack('g-1024-public-corpus', { agents: true, library: true });
  const relay = new Pool({ connectionString: process.env.ACCOUNT_RELAY_DATABASE_URL });
  try {
    const member = await stack.member('author');
    await initializeRelayCheckpoint(relay, process.env.MAIN_RELAY_CONSUMER!, stack.env.lineage.dataEpoch);
    const api = workProfileCorpusApi('http://main.local', member.token, {
      fetch: ((input, init) => stack.main.handle(new Request(input, init))) as typeof fetch,
    });
    const actor = await api.command<{ agent: string }>('g-1024:author', {
      method: 'POST',
      path: '/v1/agents',
      body: { profile: 'agent-provision-v1', kind: 'person', displayName: 'Work profile author' },
    });
    const fixed: CorpusDimensions = {
      unrelatedWorks: 0,
      unrelatedPosts: 0,
      follows: 0,
      memberships: 0,
      historyDepth: 0,
      realmSize: 0,
      conceptVocabulary: 0,
    };
    const works: Awaited<ReturnType<typeof seedPublicProfileWork>>[] = [];
    const evidence = [];
    for (const scale of WORK_PROFILE_SCALES) {
      const dimensions = workProfileDimensions('unrelatedWorks', scale, fixed);
      const first = works.length;
      await runBoundedIndices(
        dimensions.unrelatedWorks - first,
        2,
        async (offset) => {
          const index = first + offset;
          works[index] = await seedPublicProfileWork(api, `g-1024:public-work:${index}`, {
            actingSubject: actor.agent,
            title: `Profile corpus public Work ${index}`,
            body: `Public g1024profilecorpus selected text ${index}`,
          });
        },
        () => {},
      );
      for (const [index, created] of works.entries()) {
        const selected = await api.read<{
          contribution: string;
          selectedDraft: string;
          body: string;
        }>(`/v1/main-versions/${created.mainVersion.slice(-36)}/selection?language=en`);
        expect(selected.contribution).toBe(created.contribution);
        expect(selected.selectedDraft).toBe(created.draftRevision);
        expect(selected.body).toBe(`Public g1024profilecorpus selected text ${index}`);
      }
      expect(works).toHaveLength(dimensions.unrelatedWorks);
      const candidates = await stack.fuseki.query(`PREFIX text: <http://jena.apache.org/text#>
        PREFIX rv: <https://rezics.com/vocab/>
        SELECT (COUNT(?rawUnit) AS ?candidateCount) WHERE {
          GRAPH <${PUBLIC_SEARCH_GRAPH}> {
            (?rawUnit ?score) text:query (rv:searchBody "g1024profilecorpus" 129) .
          }
        }`);
      expect(fusekiCandidateCounts(candidates).counts).toEqual([dimensions.unrelatedWorks]);
      expect(performance.now() - started).toBeLessThan(600_000);
      evidence.push({
        scale,
        works: works.length,
        cumulativePreparationMs: performance.now() - started,
        basis: 'public command and read-back preparation; stopped backup/restore not exercised',
      });
    }
    mkdirSync('.temp/work-profiles', { recursive: true });
    writeFileSync(
      '.temp/work-profiles/g-1024-public-corpus.json',
      JSON.stringify(evidence, null, 2) + '\n',
    );
  } finally {
    await relay.end();
    await stack.stop();
  }
}, 420_000);
