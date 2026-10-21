import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTelemetry, flushTelemetryTraces, shutdownTelemetry } from '@rezics/observability/runtime';
import { profileRequest, startWorkProfileSink, type WorkProfile } from '../support/work-profile.ts';

test('Realm placement publication stays bounded as its ranking grows and eight writers meet the native deadline', async () => {
  const sink = startWorkProfileSink({ settleMs: 25 });
  startTelemetry('realm-placement-growth', { ...process.env, ...sink.env });
  const { realmVisibilityFixture } = await import('../../../services/main/tests/realm-visibility-fixture.ts');
  const h = await realmVisibilityFixture();
  const profiles: { size: number; profile: WorkProfile }[] = [];
  const preparation: { size: number; phase: string; profile: WorkProfile }[] = [];
  const batches: { size: number; elapsedMs: number; latenciesMs: number[] }[] = [];
  const directory = join(process.env.REZICS_QA_ARTIFACT_DIR!, 'realm-placement-growth');
  mkdirSync(directory, { recursive: true });
  let count = 0;
  const request = async (path: string, input: object, headers = new Headers()) => {
    const response = await h.app.handle(new Request(`http://main.local${path}`, {
      method: 'POST', headers: { ...Object.fromEntries(headers), authorization: `Bearer ${await h.currentToken()}`,
        'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify(input),
    }));
    const body = await response.json() as Record<string, unknown>;
    expect(response.status, JSON.stringify(body)).toBe(201);
    return body;
  };
  const publish = async (input: object, headers = new Headers()) => {
    const body = await request('/v1/realm-reply-placements', input, headers);
    count++;
    return body;
  };
  const options = { service: 'realm-placement-growth', peers: { fuseki: Bun.env.FUSEKI_URL! }, flush: flushTelemetryTraces };
  const prepare = async (size: number) => {
    const input = h.draftInput();
    const draft = await profileRequest(sink, headers => request('/v1/member-reply-drafts', input, headers), options);
    preparation.push({ size, phase: 'draft', profile: draft.profile });
    const identity = await profileRequest(sink, headers => request('/v1/realm-replies', {
      profile: 'realm-reply-identity-v1', reply: input.reply, variantId: input.variantId,
      revisionId: draft.result.revisionId, author: h.actor, rootTarget: input.rootTarget,
      rootRevision: input.rootRevision, parentReply: null, parentRevision: null, contextRevision: null,
    }, headers), options);
    preparation.push({ size, phase: 'identity', profile: identity.profile });
    writeFileSync(join(directory, 'preparation.json'), JSON.stringify(preparation, null, 2));
    return { profile: 'realm-reply-placement-v1', realm: h.realm, reply: input.reply,
      revisionId: draft.result.revisionId, revisionDigest: draft.result.revisionDigest,
      reviewDecisionId: null, expectedHead: null, actingSubject: h.actor };
  };
  const locks = { samples: 0, waitingSamples: 0, peakWaiters: 0 };
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const result = await h.accessPool.query<{ waiters: number }>(`SELECT count(*)::integer AS waiters
        FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'`);
      const waiters = result.rows[0]!.waiters;
      locks.samples++;
      if (waiters) locks.waitingSamples++;
      locks.peakWaiters = Math.max(locks.peakWaiters, waiters);
      await Bun.sleep(10);
    }
  })();
  try {
    await h.policy('public', 'open');
    for (const size of [8, 64]) {
      const started = performance.now();
      const before = count;
      while (count < size) {
        const reply = await h.reply();
        await publish(reply.placement);
      }
      console.info(JSON.stringify({ capability: 'realm-placement-population', size,
        publications: count - before, elapsedMs: performance.now() - started }));
      const placement = await prepare(size);
      const measured = await profileRequest(sink, headers => publish(placement, headers), options);
      profiles.push({ size, profile: measured.profile });
      writeFileSync(join(directory, 'profiles.json'), JSON.stringify(profiles, null, 2));
      console.info(JSON.stringify({ capability: 'realm-placement-publication', size,
        latencyMs: measured.profile.totalLatencyMs, graphCalls: measured.profile.fusekiRequests,
        sqlStatements: measured.profile.postgresStatements,
        sqlRows: measured.profile.spans.reduce((sum, span) => sum + Number(span.attributes['rezics.postgres.rows'] ?? 0), 0),
        native: measured.profile.fusekiCalls.filter(call => call.nativeWork) }));
      expect(measured.profile.postgresStatements).not.toBeNull();
      expect(measured.profile.postgresStatements!).toBeLessThanOrEqual(164);
      expect(measured.profile.fusekiRequests).toBe(12);
      const ready = [];
      for (let n = 0; n < 8; n++) ready.push(await h.reply());
      const batchStart = performance.now();
      const latenciesMs = await Promise.all(ready.map(async item => {
        const start = performance.now();
        await publish(item.placement);
        return performance.now() - start;
      }));
      batches.push({ size, elapsedMs: performance.now() - batchStart, latenciesMs });
      writeFileSync(join(directory, 'batches.json'), JSON.stringify(batches, null, 2));
      console.info(JSON.stringify({ capability: 'realm-placement-concurrency', ...batches.at(-1) }));
      expect(Math.max(...latenciesMs)).toBeLessThan(12_000);
    }
    expect(profiles[1]!.profile.postgresStatements).toBe(profiles[0]!.profile.postgresStatements);
    for (const [counter, value] of Object.entries(profiles[0]!.profile.nativeVisits)) {
      // Sequence literals gain decimal digits as the source grows. Bound their
      // bytes separately from visits/mutations, which must stay identical.
      if (counter.endsWith('_literal_bytes')) {
        expect(value).toBeLessThanOrEqual(512);
        expect(profiles[1]!.profile.nativeVisits[counter]).toBeLessThanOrEqual(512);
      } else expect(profiles[1]!.profile.nativeVisits[counter]).toBe(value);
    }
  } finally {
    sampling = false;
    await sampler;
    writeFileSync(join(directory, 'locks.json'), JSON.stringify({ sampleIntervalMs: 10, ...locks }, null, 2));
    console.info(JSON.stringify({ capability: 'realm-placement-access-locks', sampleIntervalMs: 10, ...locks }));
    await h.close();
    await shutdownTelemetry();
    await sink.stop();
  }
}, 600_000);
