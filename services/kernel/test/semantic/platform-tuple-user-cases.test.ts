import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { Statement, StatementInput, Subject } from '../../../../specs/semantic-driver.ts';
import { holdsCurrentStatements } from '../../src/search/current-leaf.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  discoveryStatement,
  type CreatedSubject,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';

let fixture: ReleasedDiscoveryFixture;
let platforms: { switch: CreatedSubject; pc: CreatedSubject };
beforeAll(async () => {
  fixture = await createReleasedDiscoveryFixture({ version: 1 });
  const scheme = await fixture.createSubject('skos:ConceptScheme', 'Editorial platform assertions');
  platforms = {
    switch: await fixture.createSubject('skos:Concept', 'Nintendo Switch'),
    pc: await fixture.createSubject('skos:Concept', 'PC'),
  };
  for (const platform of Object.values(platforms)) {
    await fixture.adopt(platform, discoveryStatement('skos:inScheme', scheme.id));
    const value = await read(platform);
    expect(value.type).toBe('skos:Concept');
    expect(value.statements['skos:inScheme']![0]!.value.content).toBe(scheme.id);
  }
}, 180_000);
afterAll(async () => {
  await fixture?.close();
}, 180_000);

async function read(holder: CreatedSubject): Promise<Subject> {
  const response = await fixture.read(holder);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const subject = response.body.subject as Subject;
  expect(subject.id).toBe(holder.id);
  expect(subject.release).toBe(bundledDigest);
  return subject;
}
function platformStatement(platform: CreatedSubject, language?: string): StatementInput {
  return {
    ...discoveryStatement('schema:gamePlatform', platform.id),
    qualifiers:
      language === undefined
        ? []
        : [{ property: { id: 'schema:inLanguage' }, value: { type: 'value', content: language } }],
  };
}
function selected(subject: Subject): Statement[] {
  return (subject.statements['schema:gamePlatform'] ?? []).filter((statement) => statement.rank !== 'deprecated');
}
// Supplementary conformance over actual HTTP evidence; this is not a Search/list binding or an absence proof.
function matches(statements: Statement[], platform: CreatedSubject, language: string): boolean {
  return holdsCurrentStatements(
    statements.map((statement) => ({
      property: statement.property.id,
      value: String(statement.value.content),
      qualifiers: statement.qualifiers
        .filter((part) => part.value.type === 'value')
        .map((part) => ({
          property: part.property.id,
          value: String(part.value.content),
        })),
    })),
    {
      facet: 'statement',
      property: 'schema:gamePlatform',
      values: [platform.id],
      qualifiers: [{ property: 'schema:inLanguage', in: [language] }],
    },
  );
}

test('release platform language qualifiers belong to one actual statement and never form a Cartesian tuple', async () => {
  const definition = fixture.release.definition;
  expect(definition.properties['schema:gamePlatform']).toMatchObject({
    datatype: 'wikibase-item',
    targets: ['skos:Concept'],
  });
  expect(definition.properties['schema:inLanguage']!.datatype).toBe('string');
  const work = await fixture.createSubject('schema:VideoGame', 'Aggregate platform work', {
    'schema:gamePlatform': [platformStatement(platforms.switch), platformStatement(platforms.pc)],
    'schema:inLanguage': [discoveryStatement('schema:inLanguage', 'ja'), discoveryStatement('schema:inLanguage', 'en')],
  });
  const release = await fixture.createSubject('wd:Q20631656', 'Explicitly associated multi-platform release');
  const otherRelease = await fixture.createSubject('wd:Q20631656', 'Independent PC release');
  for (const holder of [release, otherRelease])
    await fixture.adopt(holder, discoveryStatement('schema:exampleOfWork', work.id));
  const japanese = platformStatement(platforms.switch, 'ja');
  const english = platformStatement(platforms.pc, 'en');
  // The first missing admission must be an expected-201 red outcome, never a successful 422 assertion.
  const proposed = await fixture.request(
    'editor',
    'POST',
    `/v1/subjects/${release.id}/candidates`,
    { statement: japanese },
    discoveryKey(),
  );
  expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
  const switchFact = await fixture.adopt(release, japanese);
  // Classification values share one property slot; the next CAS selects both associated statements.
  const pcProposed = await fixture.request(
    'editor',
    'POST',
    `/v1/subjects/${release.id}/candidates`,
    { statement: english },
    discoveryKey(),
  );
  expect(pcProposed.status, JSON.stringify(pcProposed.body)).toBe(201);
  const pcCandidate = pcProposed.body.candidate as string;
  const pcAccepted = await fixture.request(
    'acceptor',
    'POST',
    `/v1/subjects/${release.id}/candidates/${pcCandidate}:accept`,
    { context: GLOBAL_CONTEXT, expected_head: null },
    discoveryKey(),
  );
  expect(pcAccepted.status, JSON.stringify(pcAccepted.body)).toBe(200);
  const pcAdopted = await fixture.request(
    'acceptor',
    'POST',
    `/v1/subjects/${release.id}:adopt`,
    {
      context: GLOBAL_CONTEXT,
      property: 'schema:gamePlatform',
      mode: 'replace',
      selection: [
        { candidate: switchFact.candidate, rank: japanese.rank ?? 'normal' },
        { candidate: pcCandidate, rank: english.rank ?? 'normal' },
      ],
      expected_head: switchFact.adoptionHead,
    },
    discoveryKey(),
  );
  expect(pcAdopted.status, JSON.stringify(pcAdopted.body)).toBe(200);
  const pcFact = {
    candidate: pcCandidate,
    release: release.release,
    acceptanceHead: (pcAccepted.body.acceptance as { head: number }).head,
    adoptionHead: (pcAdopted.body.adoption as { head: number }).head,
  };
  await fixture.adopt(otherRelease, english);
  await fixture.catchUp([work, release, otherRelease]);
  const facts = selected(await read(release));
  expect(facts.map((fact) => fact.id).sort()).toEqual([switchFact.candidate, pcFact.candidate].sort());
  for (const [receipt, input] of [
    [switchFact, japanese],
    [pcFact, english],
  ] as const) {
    expect(receipt.release).toBe(bundledDigest);
    expect(receipt.acceptanceHead).toBeGreaterThan(0);
    expect(receipt.adoptionHead).toBeGreaterThan(0);
    expect(facts.find((fact) => fact.id === receipt.candidate)).toMatchObject({
      value: input.value,
      qualifiers: input.qualifiers,
      rank: 'preferred',
      rezics: { release: bundledDigest },
    });
  }
  expect(matches(facts, platforms.switch, 'ja')).toBe(true);
  expect(matches(facts, platforms.pc, 'en')).toBe(true);
  expect(matches(facts, platforms.switch, 'en')).toBe(false);
  expect(matches(facts, platforms.pc, 'ja')).toBe(false);
  expect(matches(selected(await read(otherRelease)), platforms.switch, 'ja')).toBe(false);
  expect(matches(selected(await read(work)), platforms.switch, 'en')).toBe(false);
  expect((await read(release)).statements['schema:exampleOfWork']![0]!.value.content).toBe(work.id);
}, 120_000);

test('compact and expanded selected platform support preserve unknown and source disclosure', async () => {
  const input = platformStatement(platforms.switch, 'ja');
  const compactResponse = await fixture.request(
    'editor',
    'POST',
    '/v1/subjects',
    {
      type: 'wd:Q20631656',
      labels: { en: 'Compact explicit release association' },
      statements: { 'schema:gamePlatform': [input] },
    },
    discoveryKey(),
  );
  expect(compactResponse.status, JSON.stringify(compactResponse.body)).toBe(201);
  const compact = compactResponse.body.subject as Subject;
  const compactHolder = { id: compact.id, release: compact.release, revision: compact.revision };
  const expanded = await fixture.createSubject('wd:Q20631656', 'Expanded explicit release association');
  const receipt = await fixture.adopt(expanded, input);
  const a = selected(await read(compactHolder))[0]!;
  const b = selected(await read(expanded))[0]!;
  expect(b).toMatchObject({
    property: a.property,
    value: a.value,
    qualifiers: a.qualifiers,
    references: a.references,
    rank: a.rank,
  });
  expect(a.rezics).toEqual({ release: bundledDigest, revision: 1 });
  expect(b.rezics.release).toBe(bundledDigest);
  expect(b.id).toBe(receipt.candidate);
  for (const fact of [a, b]) {
    expect(fact.rank).toBe('preferred');
    expect(fact.references).toHaveLength(1);
    expect(fact.references[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(fact.references[0]!.parts[0]!.value.content).toBe(
      'https://example.org/released-discovery/v1/controlled-assertions',
    );
  }
  const alternative = await fixture.request(
    'editor',
    'POST',
    `/v1/subjects/${expanded.id}/candidates`,
    { statement: platformStatement(platforms.switch, 'en') },
    discoveryKey(),
  );
  expect(alternative.status, JSON.stringify(alternative.body)).toBe(201);
  expect(selected(await read(expanded))).toEqual([b]);
  const missing = await fixture.createSubject('wd:Q20631656', 'No asserted language', {
    'schema:gamePlatform': [platformStatement(platforms.switch)],
  });
  const unknownResponse = await fixture.request(
    'editor',
    'POST',
    '/v1/subjects',
    {
      type: 'wd:Q20631656',
      labels: { en: 'Explicit unknown language' },
      statements: {
        'schema:gamePlatform': [
          { ...input, qualifiers: [{ property: { id: 'schema:inLanguage' }, value: { type: 'somevalue' } }] },
        ],
      },
    },
    discoveryKey(),
  );
  expect(unknownResponse.status, JSON.stringify(unknownResponse.body)).toBe(201);
  const unknown = unknownResponse.body.subject as CreatedSubject;
  expect(selected(await read(missing))[0]!.qualifiers).toEqual([]);
  expect(selected(await read(unknown))[0]!.qualifiers).toMatchObject([
    { property: { id: 'schema:inLanguage' }, value: { type: 'somevalue' } },
  ]);
  // No NOT/exclusion inference follows from either missing or unknown language.
  for (const holder of [missing, unknown])
    expect(matches(selected(await read(holder)), platforms.switch, 'en')).toBe(false);

  const before = await read(expanded);
  // A candidate from another actual release cannot populate this holder's property slot.
  const foreign = await fixture.request(
    'acceptor',
    'POST',
    `/v1/subjects/${expanded.id}:adopt`,
    {
      context: before.context,
      property: 'schema:gamePlatform',
      mode: 'replace',
      selection: [{ candidate: a.id, rank: 'preferred' }],
      expected_head: receipt.adoptionHead,
    },
    discoveryKey(),
  );
  expect(foreign.status, JSON.stringify(foreign.body)).toBe(400);
  expect(foreign.body.errors).toEqual([{ pointer: '/selection/0/candidate', code: 'unsupported' }]);
  const stale = await fixture.request(
    'acceptor',
    'POST',
    `/v1/subjects/${expanded.id}:adopt`,
    {
      context: before.context,
      property: 'schema:gamePlatform',
      mode: 'replace',
      selection: [],
      expected_head: null,
    },
    discoveryKey(),
  );
  expect(stale.status, JSON.stringify(stale.body)).toBe(409);
  expect(await read(expanded)).toEqual(before);
  const wrongTarget = await fixture.createSubject('schema:Person', 'A person is not a platform Concept');
  const invalid = await fixture.request(
    'editor',
    'POST',
    `/v1/subjects/${expanded.id}/candidates`,
    { statement: platformStatement(wrongTarget, 'ja') },
    discoveryKey(),
  );
  expect(invalid.status, JSON.stringify(invalid.body)).toBe(400);
  expect(await read(expanded)).toEqual(before);

  await fixture.grant('steward', ['moderation:hide', 'moderation:takedown'], before.context);
  const hidden = await fixture.request(
    'steward',
    'POST',
    `/v1/subjects/${expanded.id}/candidates/${b.id}:hide`,
    { reason: 'spam' },
    discoveryKey(),
  );
  expect(hidden.status, JSON.stringify(hidden.body)).toBe(200);
  expect(selected(await read(expanded))).toEqual([]);
  // Withholding the statement also withholds its language and reference; it proves no negative tuple.
  expect(selected(await read(compactHolder))).toEqual([a]);
  const restored = await fixture.request(
    'steward',
    'POST',
    `/v1/subjects/${expanded.id}/candidates/${b.id}:restore`,
    { reason: 'appeal' },
    discoveryKey(),
  );
  expect(restored.status, JSON.stringify(restored.body)).toBe(200);
  expect(selected(await read(expanded))).toEqual([b]);
}, 120_000);
