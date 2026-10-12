import { beforeAll, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { startTelemetry, flushTelemetryTraces, shutdownTelemetry } from '../../../packages/observability/src/runtime.ts';
import { commandCounters } from '../../../packages/observability/src/http-measurement.ts';
import { runWorkProfileChild } from '../../../tests/qa/support/work-profile-child.ts';
import { assertWorkCostAtScales, profileRequest, startWorkProfileSink, type WorkProfile }
  from '../../../tests/qa/support/work-profile.ts';
import { WORK_PROFILE_SCALES, workProfileDimensions } from '../../../scripts/load/work-profile-corpus.ts';

interface QueryEvidence {
  attempt: number;
  read: string;
  callsLeft: number;
  bytesLeft: number;
  bytesSpent: number;
}
interface Reading {
  endpoint: string;
  shape: 'text' | 'rich' | 'attachments';
  concurrent: boolean;
  attachments: number;
  status: number;
  code: string | null;
  attempts: number;
  writes: number;
  ceiling: 'calls' | 'bytes' | null;
  deliveredCover: boolean;
  nativeVisits: Record<string, number | null>;
  queries: QueryEvidence[];
  profile: WorkProfile;
}
interface Evidence {
  readings: Reading[];
  attachmentSizes: number[];
  missingEndpoints: string[];
  preparationMs: number;
}

const attachmentSizes = WORK_PROFILE_SCALES.map(scale => 4 * workProfileDimensions('unrelatedWorks', scale, {
  unrelatedWorks: 0, unrelatedPosts: 0, follows: 0, memberships: 0, historyDepth: 0,
  realmSize: 0, conceptVocabulary: 0,
}).unrelatedWorks);

// Instrumentation must start before the real HTTP and PostgreSQL clients load.
if (process.env.REZICS_ZONE_BUDGET_PROFILE_CHILD === '1') {
  if (!process.env.REZICS_QA_RUN_ID) throw new Error('Run through goalctl test');
  const sink = startWorkProfileSink({ settleMs: 25 });
  startTelemetry('main', { ...process.env, ...sink.env, OTEL_SERVICE_NAME: 'main' });
  const { startHomeStack } = await import('../../../tests/qa/integration/feed-read-support.ts');
  const { grantFixtureAuthority } = await import('../src/modules/access/fixture-authority.ts');
  const { AccessRealmManagement } = await import('../src/modules/access/realm-management.ts');
  const { RealmAboutThreadStore } = await import('../src/modules/realm-reply/about-store.ts');
  const { readZoneConfiguration } = await import('../src/modules/zone/configuration.ts');
  const { GLOBAL_CONTEXT_SCOPE } = await import('../src/modules/rating/global.ts');
  const { fusekiReadBudget, FusekiReadBudgetExceeded } = await import('../src/infrastructure/fuseki.ts');
  const { GRAPHS, iri } = await import('../src/modules/work/activate.ts');
  const { fromPlainText } = await import('@rezics/document');
  const { foregroundCounted } = await import('../../../tests/qa/integration/support/query-cost-meter.ts');
  const sharp = (await import('sharp')).default;
  const home = await startHomeStack('zone-resource-page-budget', { projectionStart: 'current' });
  const evidence: Evidence = { readings: [], attachmentSizes, missingEndpoints: [], preparationMs: 0 };
  const prepared = performance.now();
  try {
    const { stack, call, json } = home;
    const actor = await home.provision('Zone resource author', home.author.token);
    const grant = (scope: string, action: string) => grantFixtureAuthority(stack.accessPool, {
      scope, requireDispatch: true,
      representations: [{ principalId: home.author.principalId, actor, action, lifetime: '8 hours' }],
      grant: { actor, action, lifetime: '8 hours' },
    });
    const send = (method: string, endpoint: string, body: object) => call(method, endpoint, body, home.author.token);
    await grant('space:create:root', 'space.create');
    const realm = await json<{ realm: string; space: string }>(await send('POST', '/v1/spaces', {
      profile: 'space-realm-v2', name: 'Resource budget community', language: 'en', capabilities: ['realm'],
      initialSettings: { visibility: 'public', reviewMode: 'open', reviewRequired: false,
        whoMaySubmit: 'granted', selfJoin: false, rules: [] }, actingSubject: actor,
    }), 201);
    await new AccessRealmManagement(stack.accessPool).initialize({ ...home.author.principal,
      emailVerified: true }, realm.realm, actor, stack.env);
    const site = await json<{ zone: string; space: string; navigationRevision: string }>(await send('POST', '/v1/spaces', {
      profile: 'space-zone-v1', name: 'Resource budget site', language: 'en', capabilities: ['zone'],
      visibility: 'public', listing: 'listed', actingSubject: actor,
    }), 201);
    await grant(`zone:edit:${site.zone}`, 'zone.edit');
    await json(await send('PUT', `/v1/zones/${site.zone.slice(-36)}/configuration`, {
      expectedHead: (await readZoneConfiguration(stack.env, site.zone)).revision,
      defaultRealm: realm.realm, actingSubject: actor,
    }));
    const work = await stack.publicWork(actor, ['en'], 'Harbor field guide');
    const workPath = `/v1/works/${work.work.slice(-36)}`;
    const pagePath = `/v1/resources/${work.work.slice(-36)}/page`;
    await grant(`work:edit:${work.work}`, 'work.edit');
    await grant(`work:read:${work.work}`, 'work.read');
    const head = async () => {
      const rows = (await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
        SELECT ?head WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(work.work)} rv:head ?head } } LIMIT 2`)).results?.bindings ?? [];
      expect(rows).toHaveLength(1);
      return rows[0]!.head!.value;
    };
    const collection = `https://rezics.com/id/${randomUUID()}`;
    await grant(`collection:edit:${collection}`, 'collection.edit');
    await grant(`semantic:read:${collection}`, 'semantic.read');
    const curated = await json<{ structure: string; revision: string }>(await send('POST', '/v1/collections', {
      collection, name: 'Harbor reading shelf', language: 'en', disclosure: 'public', actingSubject: actor,
    }), 201);
    await json(await send('POST', `/v1/collections/${collection.slice(-36)}/changes`, {
      expectedHead: curated.revision, actingSubject: actor,
      operations: [{ op: 'insert', parent: curated.structure, position: 'last', role: 'member',
        target: work.work, selection: { mode: 'follow-context' } }],
    }));
    const mounts = await json<{ revision: string }>(await send('POST', `/v1/zones/${site.zone.slice(-36)}/mounts`, {
      expectedHead: site.navigationRevision, target: collection, routeSegment: 'guide',
      disclosure: 'public', actingSubject: actor,
    }));
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const draft = await json<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
      await send('POST', '/v1/content-drafts', {
        profile: 'content-text-v1', resourceId: site.zone, variantId, expectedHead: null,
        document: fromPlainText('Harbor annex home', 'blocks'),
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', actingSubject: actor,
      }), 201);
    await json(await send('POST', `/v1/zones/${site.zone.slice(-36)}/site-publications`, {
      expectedHead: (await readZoneConfiguration(stack.env, site.zone)).revision,
      routesRevision: mounts.revision, navigationRevision: mounts.revision, actingSubject: actor,
      pages: [{ page: site.zone, variantId, revisionId: draft.revisionId, byteDigest: draft.byteDigest,
        contentEpoch: draft.sourcePosition.dataEpoch }],
    }), 201);
    const about = new RealmAboutThreadStore(stack.contentPool);
    const reservation = await about.reserve({ realm: realm.realm, about: work.work, actor,
      intentKey: randomUUID(), intentDigest: 'a'.repeat(64), rootRevision: await head() });
    expect(await about.readThread(realm.realm, work.work)).toMatchObject({ state: 'reserved',
      openerReply: reservation.openerReply });

    let active: { reading: Omit<Reading, 'profile' | 'nativeVisits'>; probes: number;
      budget?: NonNullable<ReturnType<typeof fusekiReadBudget.getStore>> } | undefined;
    let writing = false;
    let writeHead = await head();
    let writeSerial = 0;
    const originalQuery = stack.fuseki.query.bind(stack.fuseki);
    const classify = (query: string) => query.includes('SELECT ?work ?head ?owningWork') ? 'disclosure-heads'
      : query.includes('SELECT ?work ?head ?nameOwner') ? 'disclosure-name-owner'
      : /SELECT\s+\?epoch\s+\?sequence\s+WHERE/.test(query) ? 'position'
      : query.includes('SELECT ?r ?type') ? 'summary'
      : query.includes('SELECT DISTINCT ?origin') ? 'merged-origins'
      : query.includes('SELECT ?realm ?payload') ? 'realm-profile-names'
      : 'owner-read';
    stack.fuseki.query = async (query, maximum) => {
      const budget = fusekiReadBudget.getStore();
      const context = !writing && foregroundCounted() ? active : undefined;
      if (!context || !budget) return originalQuery(query, maximum);
      context.budget ??= budget;
      const basis = budget === context.budget && /SELECT\s+(?:\?epoch\s+)?\?sequence\s+WHERE/.test(query)
        && query.includes('rv:routingEpoch');
      if (basis) {
        context.probes++;
        if (context.probes % 2 === 1) context.reading.attempts++;
        else if (context.reading.concurrent) {
          // A real independent edit commits between the read's opening and closing snapshots.
          writing = true;
          try {
            await fusekiReadBudget.exit(async () => {
              const headers = new Headers({ authorization: `Bearer ${home.author.token}`,
                'content-type': 'application/json', 'idempotency-key': randomUUID(),
                traceparent: `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01` });
              const changed = await json<{ revision: string }>(await home.app.handle(new Request(
                `http://main.local${workPath}/scalar-value`, { method: 'POST', headers,
                  body: JSON.stringify({ profile: 'work-scalar-state-v1', expectedHead: writeHead,
                    actingSubject: actor, scalarValue: { kind: ++writeSerial % 2 ? 'unknown' : 'no-value' } }) })));
              writeHead = changed.revision;
              context.reading.writes++;
            });
          } finally { writing = false; }
        }
      }
      const before = budget.bytesLeft;
      try { return await originalQuery(query, maximum); }
      catch (error) {
        if (error instanceof FusekiReadBudgetExceeded) {
          context.reading.ceiling = error.message.includes('call budget') ? 'calls' : 'bytes';
        }
        throw error;
      } finally {
        context.reading.queries.push({ attempt: context.reading.attempts, read: classify(query),
          callsLeft: budget.callsLeft, bytesLeft: budget.bytesLeft, bytesSpent: before - budget.bytesLeft });
      }
    };
    const measure = async (endpoint: string, shape: Reading['shape'], concurrent = false, attachments = 0) => {
      const reading: Omit<Reading, 'profile' | 'nativeVisits'> = { endpoint, shape, concurrent, attachments,
        status: 0, code: null, attempts: 0, writes: 0, ceiling: null, deliveredCover: false, queries: [] };
      active = { reading, probes: 0 };
      try {
        const measured = await profileRequest(sink, async headers => {
          headers.set('authorization', `Bearer ${home.author.token}`);
          const url = new URL(`http://main.local${endpoint}`);
          url.searchParams.set('actingSubject', actor);
          const response = await home.app.handle(new Request(url, { headers }));
          reading.status = response.status;
          const text = await response.text();
          let body: { code?: string; summary?: { avatar?: { kind?: string } } } | null = null;
          try { body = text ? JSON.parse(text) : null; } catch { /* An unmounted endpoint may return text. */ }
          reading.code = body?.code ?? null;
          reading.deliveredCover = body?.summary?.avatar?.kind === 'image';
          return body;
        }, { service: 'main', flush: flushTelemetryTraces });
        const visits = commandCounters.filter(counter => counter.endsWith('_visited') || counter.endsWith('_visits'));
        const nativeVisits: Record<string, number | null> = Object.fromEntries(visits.map(counter => [counter, null]));
        for (const span of measured.profile.spans) for (const counter of visits) {
          const value = span.attributes[`rezics.fuseki.${counter}`];
          if (typeof value === 'number') nativeVisits[counter] = (nativeVisits[counter] ?? 0) + value;
        }
        expect(measured.profile.fusekiRequests).not.toBeNull();
        evidence.readings.push({ ...reading, profile: measured.profile, nativeVisits });
        console.log('Zone resource budget', JSON.stringify({ endpoint, shape, concurrent, attachments,
          status: reading.status, attempts: reading.attempts, writes: reading.writes, ceiling: reading.ceiling,
          calls: measured.profile.fusekiRequests, sentBytes: measured.profile.fusekiSentBytes,
          receivedBytes: measured.profile.fusekiReceivedBytes, nativeVisits }));
        return measured.result;
      } finally { active = undefined; sink.clear(); }
    };
    const endpoints = [
      `/v1/zones/${site.zone.slice(-36)}/routes?path=${encodeURIComponent(`/guide/${work.work.slice(-36)}`)}`,
      pagePath, workPath,
      `/v1/realms/${realm.realm.slice(-36)}/about-thread?about=${encodeURIComponent(work.work)}`,
      `/v1/realms/${realm.realm.slice(-36)}`,
      `/v1/realms/${realm.realm.slice(-36)}/joining`,
      `/v1/realms/${realm.realm.slice(-36)}/threads/${reservation.openerReply.slice(-36)}`,
    ];
    for (const endpoint of endpoints) await measure(endpoint, 'text');
    evidence.missingEndpoints = evidence.readings.filter(reading => reading.status === 404
      && reading.endpoint.includes('/about-thread')).map(reading => reading.endpoint);

    // Recipe is the registered Work-publication source; Book composition has no such contract.
    await json(await send('PUT', `${workPath}/type`, { profile: 'work-type-v2', expectedHead: await head(),
      types: ['https://schema.org/Recipe'], actingSubject: actor }));
    await grant(`work:edit:${work.work}`, 'recipe.edit');
    await grant(`work:publish:${work.work}`, 'work.publish');
    const structure = await json<{ structure: string; revision: string }>(await send('POST', '/v1/compositions', {
      profile: 'recipe-composition', work: work.work, mainVersion: work.mainVersion, actingSubject: actor,
    }), 201);
    await json(await send('POST', '/v1/work-publications', {
      profile: 'work-structure-publication-v1', operation: 'publish', work: work.work, actingSubject: actor,
      expectedWorkHead: await head(), expectedMainVersion: work.mainVersion, structure: structure.structure,
      expectedStructureHead: structure.revision, expectedPublicationHead: null, disclosure: 'public',
      rightsBasis: 'original-contribution',
    }), 201);
    await grant(GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
    const rating = await json<{ context: string }>(await send('POST', '/v1/global-rating-contexts', {
      profile: 'global-rating-standing-context-v1', question: 'Guide quality', actingSubject: actor,
    }), 201);
    await grant(`rating:observe:${rating.context}`, 'rating.observation.set');
    await json(await send('POST', '/v1/global-rating-observations', {
      profile: 'global-rating-standing-observation-v1', context: rating.context, work: work.work,
      mainVersion: work.mainVersion, expectedRevisionHead: null, value: 5, actingSubject: actor,
    }), 201);
    writeHead = await head();
    for (const endpoint of endpoints) {
      await measure(endpoint, 'rich');
      await measure(endpoint, 'rich', true);
    }

    const pixels = await sharp({ create: { width: 256, height: 256, channels: 4,
      background: { r: 20, g: 50, b: 80, alpha: 1 } } }).png().toBuffer();
    const upload = await home.author.upload(pixels);
    // Media assets belong to the uploading Agent; this author remains the real asset owner.
    const attach = async (target: string) => {
      await grantFixtureAuthority(stack.accessPool, {
        scope: `media:avatar:${target}`, requireDispatch: true,
        representations: [{ principalId: home.author.principalId, actor: home.author.actor,
          action: 'media.avatar', lifetime: '8 hours' }],
        grant: { actor: home.author.actor, action: 'media.avatar', lifetime: '8 hours' },
      });
      await json(await home.author.send('PUT', `/v1/resources/${target.slice(-36)}/avatar`, {
        profile: 'resource-avatar-selection-v1', expectedSelection: null, asset: upload.asset,
        crop: null, actingSubject: home.author.actor,
      }), 201);
    };
    await attach(work.work);
    let count = 1;
    for (const size of attachmentSizes) {
      while (count < size) {
        const attached = await stack.publicWork(actor, ['en'], `Shared guide cover ${count}`);
        await attach(attached.work);
        count++;
        if (count % 16 === 0) { await flushTelemetryTraces(); sink.clear(); }
        if (performance.now() - prepared > 600_000) throw new Error('Fixture preparation exceeded ten minutes');
      }
      const facts = await stack.store.visibilityFacts([`https://rezics.com/id/${upload.asset}`]);
      expect(facts.get(`https://rezics.com/id/${upload.asset}`)?.attachments).toHaveLength(size);
      await measure(pagePath, 'attachments', false, size);
    }
    evidence.preparationMs = performance.now() - prepared;
  } finally {
    const destination = process.env.REZICS_WORK_PROFILE_RESULT!;
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, JSON.stringify(evidence));
    await home.stop();
    await sink.stop();
    await shutdownTelemetry();
  }
} else {
  let evidence: Evidence;
  let resultPath: string;
  const summary = (readings: Reading[]) => readings.map(reading => ({ endpoint: reading.endpoint,
    status: reading.status, attachments: reading.attachments, attempts: reading.attempts, writes: reading.writes,
    calls: reading.profile.fusekiRequests, bytes: reading.profile.fusekiReceivedBytes, ceiling: reading.ceiling }));
  beforeAll(async () => {
    const child = await runWorkProfileChild('services/main/tests/zone-resource-page-budget.integration.test.ts', {
      env: { REZICS_ZONE_BUDGET_PROFILE_CHILD: '1' }, timeoutMs: 660_000,
    });
    resultPath = child.resultPath;
    evidence = JSON.parse(readFileSync(resultPath, 'utf8')) as Evidence;
    console.log('Zone resource budget evidence', resultPath, JSON.stringify(summary(evidence.readings)));
  }, 660_000);

  test('quiet resource pages hydrate the text and structured/rating fixture before adversarial reads', () => {
    for (const shape of ['text', 'rich']) {
      const quiet = evidence.readings.find(reading => reading.shape === shape && !reading.concurrent
        && reading.endpoint.includes('/page'))!;
      expect(quiet.status, JSON.stringify(summary([quiet]))).toBe(200);
      expect(quiet.attempts).toBe(1);
      expect(quiet.ceiling).toBeNull();
    }
    expect(evidence.attachmentSizes).toEqual([16, 64, 256]);
    expect(evidence.readings.filter(reading => reading.shape === 'attachments').map(reading => reading.attachments))
      .toEqual(evidence.attachmentSizes);
    const covered = evidence.readings.find(reading => reading.shape === 'attachments')!;
    expect(covered.status, JSON.stringify(summary([covered]))).toBe(200);
    expect(covered.deliveredCover).toBe(true);
    const raced = evidence.readings.find(reading => reading.shape === 'rich' && reading.concurrent
      && reading.endpoint.includes('/page'))!;
    expect(raced.attempts, JSON.stringify(summary([raced]))).toBeGreaterThan(1);
    expect(raced.writes).toBeGreaterThan(0);
  });

  // Owner: kernel; keep one request budget and stop replay before another full attempt can exhaust it.
  test.failing('concurrent rich resource-page retries stay within the remaining request budget', () => {
    const raced = evidence.readings.find(reading => reading.shape === 'rich' && reading.concurrent
      && reading.endpoint.includes('/page'))!;
    expect(raced.ceiling, `One budget; bound retries or read a consistent cut: ${JSON.stringify(summary([raced]))}; ${resultPath}`)
      .toBeNull();
  });

  // Owner: trust-ops Media; a fixed page must not hydrate every unrelated attachment of its cover.
  test.failing('resource-page work stays constant at three shared-cover attachment scales', () => {
    const readings = evidence.readings.filter(reading => reading.shape === 'attachments');
    const message = `Shared-cover attachments ${JSON.stringify(summary(readings))}; ${resultPath}`;
    try {
      assertWorkCostAtScales(readings.map(reading => reading.profile), {
        fusekiRequests: readings[0]!.profile.fusekiRequests! * 1.2,
      }, message);
    } catch (cause) { throw new Error(message, { cause }); }
  });
}
