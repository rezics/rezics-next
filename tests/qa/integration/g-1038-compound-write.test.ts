import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startTelemetry, flushTelemetryTraces, shutdownTelemetry } from '@rezics/observability/runtime';
import { profileRequest, startWorkProfileSink } from '../support/work-profile.ts';
import { CATALOGUE_IMPORT_SCOPE, type CatalogueImportInput, type CatalogueImportOutcome } from '../../../services/main/src/modules/work/catalogue-import.ts';

/** Exercises real admission/claims, native staged validation, receipts and relay;
 * Account is the fixture's verified bearer table. Disk-scale qualification is separate. */
test('G1038: compound and bulk catalogue writes preserve denial, CAS, partial validation, replay, concurrency and lost outcomes', async () => {
  const sink = startWorkProfileSink({ settleMs: 25 });
  startTelemetry('g-1038-compound', { ...process.env, ...sink.env });
  const { startHomeStack } = await import('./feed-read-support.ts');
  const home = await startHomeStack('g-1038-compound');
  const { stack, author } = home;
  const actor = await home.json<{ agent: string }>(await home.call('POST', '/v1/agents', {
    profile: 'agent-provision-v1', kind: 'person', displayName: 'Catalogue import author',
  }, author.token), 201);
  const grant = async (scope: string, action: string) => {
    await stack.accessPool.query('INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    await stack.accessPool.query(`INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), author.principalId, actor.agent, action]);
    await stack.accessPool.query(`INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), actor.agent, scope, action]);
  };
  const base: CatalogueImportInput = { profile: 'work-catalogue-import-v1', expectedWorkHead: null,
    title: 'Imported Work', language: 'en', aliases: [{ value: 'Recorded alias', language: 'ja' }],
    description: { value: 'A catalogue description', language: 'en' }, evidence: 'G1038 independent scope fixture',
    semanticTypes: [], credits: [{ agent: actor.agent, role: 'author' }], classifications: [] };
  const single = (input = base, key = randomUUID()) => home.call('POST', '/v1/work-imports', { actingSubject: actor.agent, input }, author.token, key);
  const bulk = (items: { key: string; input: CatalogueImportInput }[]) => home.call('POST', '/v1/work-imports/bulk', { actingSubject: actor.agent, items }, author.token);
  try {
    await grant('work:create:root', 'work.create');
    const denied = await single();
    expect(denied.status, await denied.clone().text()).toBe(403); // Ordinary creation never imports or globally curates.
    await grant(CATALOGUE_IMPORT_SCOPE, 'work.create');
    await grant('classification:define:global', 'classification.proposition.define');
    const topics = [];
    for (let index = 0; index < 2; index++) topics.push(await home.json<{ sense: string; definitionRevision: string }>(
      await home.call('POST', '/v1/classification-vocabulary', {
        profile: 'classification-proposition-v2', scheme: null,
        labels: [{ value: `Compound topic ${index}`, language: 'en' }], alternativeLabels: [], broader: [], narrower: [], actingSubject: actor.agent,
      }, author.token), 201));
    const classified: CatalogueImportInput = { ...base, classifications: topics.map(topic => ({ sense: topic.sense,
      expectedSenseHead: topic.definitionRevision, expectedDecisionHead: null, outcome: 'accepted' })) };
    const items = [0, 1, 2].map(index => ({ key: randomUUID(), input: { ...classified, title: `Compound Work ${index}` } }));
    const measured = await profileRequest(sink, async headers => home.app.handle(new Request('http://main.local/v1/work-imports/bulk', {
      method: 'POST', headers: { ...Object.fromEntries(headers), authorization: `Bearer ${author.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ actingSubject: actor.agent, items }),
    })), { service: 'g-1038-compound', peers: { fuseki: Bun.env.FUSEKI_URL! }, flush: flushTelemetryTraces });
    const created = await home.json<{ items: CatalogueImportOutcome[]; complete: boolean; partial: boolean }>(measured.result);
    expect(created).toMatchObject({ complete: true, partial: false });
    expect(created.items.map(row => row.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(measured.profile.fusekiCalls.reduce((count, call) => count + (call.nativeWork?.durable_commits ?? 0), 0)).toBe(1);
    const sequences = created.items.map(row => BigInt(row.receipt!.sequence));
    expect(sequences[1]).toBe(sequences[0]! + 1n);
    expect(sequences[2]).toBe(sequences[1]! + 1n);
    const work = created.items[0]!.receipt!.work!;
    const observed = await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> PREFIX schema: <https://schema.org/> ASK {
      GRAPH <urn:rezics:graph:current> { <${work}> rv:catalogueVisible true ; schema:description "A catalogue description"@en .
        ?credit a rv:NativeAgentCredit ; rv:work <${work}> ; rv:agent <${actor.agent}> ; schema:roleName "author" .
        ?application a rv:ClassificationApplication ; rv:targetMainVersion <${created.items[0]!.receipt!.mainVersion}> ; rv:decisionHead ?decision . }
      GRAPH <urn:rezics:graph:revisions> { ?decision rv:outcome rv:Accepted }
      GRAPH <urn:rezics:search:public> { ?name rv:resource <${work}> ; rv:publicTitle "Compound Work 0"@en }
    }`);
    expect(observed.boolean).toBe(true);
    const header = await home.json<{ id: string; title: { value: string }; verification: string }>(
      await home.call('GET', `/v1/works/${work.slice(-36)}?language=en`));
    expect(header).toMatchObject({ id: work, title: { value: 'Compound Work 0' }, verification: 'verified' });
    expect((await home.json<{ items: CatalogueImportOutcome[] }>(await bulk(items))).items.map(row => row.replayed)).toEqual([true, true, true]);
    const changedKey = await bulk([{ ...items[0]!, input: { ...classified, title: 'Different intent' } }]);
    expect((await home.json<{ items: CatalogueImportOutcome[] }>(changedKey)).items[0]!.status).toBe('conflict');
    const staleKey = randomUUID();
    const partialItems = [
      { key: randomUUID(), input: base },
      { key: staleKey, input: { ...classified, credits: [{ ...base.credits[0]!, expectedAgentHead: `https://rezics.com/id/${randomUUID()}` }] } },
      { key: randomUUID(), input: base },
    ];
    const partial = await home.json<{ items: CatalogueImportOutcome[]; complete: boolean; partial: boolean }>(await bulk(partialItems));
    expect(partial).toMatchObject({ complete: true, partial: true });
    expect(partial.items.map(row => row.status)).toEqual(['succeeded', 'conflict', 'succeeded']);
    expect(partial.items[1]!.receipt!.outcome).toBe('cancelled');
    const nativeBatch = stack.fuseki.catalogueBatch.bind(stack.fuseki);
    stack.fuseki.catalogueBatch = async envelopes => nativeBatch(envelopes.map((envelope, index) => index === 1
      ? { ...envelope, update: envelope.update.replace('schema:roleName "author"', 'schema:roleName "unknown"') } : envelope));
    const invalidItems = [0, 1, 2].map(() => ({ key: randomUUID(), input: base }));
    const invalid = await home.json<{ items: CatalogueImportOutcome[] }>(await bulk(invalidItems));
    expect(invalid.items.map(row => row.status)).toEqual(['succeeded', 'invalid', 'succeeded']);
    stack.fuseki.catalogueBatch = nativeBatch;
    expect((await home.json<{ items: CatalogueImportOutcome[] }>(await bulk(invalidItems))).items[1]!.status).toBe('invalid');
    stack.fuseki.catalogueBatch = async envelopes => { await nativeBatch(envelopes); throw new Error('lost native response'); };
    const lostKey = randomUUID();
    expect((await home.json<CatalogueImportOutcome>(await single(base, lostKey), 201)).status).toBe('succeeded');
    stack.fuseki.catalogueBatch = nativeBatch;
    const record = stack.access.recordGraphOutcome.bind(stack.access);
    let failOnce = true;
    stack.access.recordGraphOutcome = async (...args) => { if (failOnce) { failOnce = false; throw new Error('lost Access outcome'); } return record(...args); };
    const uncertainKey = randomUUID();
    expect((await home.json<CatalogueImportOutcome>(await single(base, uncertainKey), 202)).status).toBe('pending');
    expect((await home.json<CatalogueImportOutcome>(await single(base, uncertainKey))).status).toBe('succeeded');
    stack.access.recordGraphOutcome = record;
    const raceKey = randomUUID(), race = await Promise.all([single(base, raceKey), single(base, raceKey)]);
    const raceRows = await Promise.all(race.map(async response => {
      expect([200, 201]).toContain(response.status);
      return await response.json() as CatalogueImportOutcome;
    }));
    expect(raceRows[0]!.receipt!.work).toBe(raceRows[1]!.receipt!.work);
    const collision = { ...base, work };
    expect((await single(collision)).status).toBe(409);
    // Relay proves every logical position even though the physical commit was shared.
    expect((await home.projectRelay()).length).toBeGreaterThan(0);
  } finally {
    await home.stop(); await shutdownTelemetry(); await sink.stop();
  }
}, 300_000);
