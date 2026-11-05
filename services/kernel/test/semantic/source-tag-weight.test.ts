import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { HttpResponse } from '../../../../specs/semantic-driver.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import {
  produceVndbSourceTagWeightCandidate,
  vndbTagsRatingEndpoint,
  vndbTagsRatingDocumentation,
} from '../../src/semantic/source-tag-weight.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';

const sourceSnapshot = new Uint8Array(
  await Bun.file(new URL('../fixtures/vndb-source-weight-v17.json', import.meta.url)).arrayBuffer(),
);
const sourceId = 'v17';
const sourceTag = 'g3';
const requestBody = JSON.stringify({
  filters: ['id', '=', sourceId],
  fields: 'id,tags{id,rating,spoiler,lie}',
  results: 1,
});
let fixture: ReleasedDiscoveryFixture;

beforeAll(async () => {
  fixture = await createReleasedDiscoveryFixture({ version: 1 });
}, 180_000);
afterAll(async () => {
  await fixture?.close();
}, 180_000);

function candidate(
  tagId = sourceTag,
  property: 'schema:genre' | 'schema:keywords' = 'schema:genre',
  contextId = GLOBAL_CONTEXT,
) {
  return produceVndbSourceTagWeightCandidate({
    endpoint: vndbTagsRatingEndpoint,
    requestBody,
    snapshot: sourceSnapshot,
    subjectId: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01',
    contextId,
    property,
    conceptId: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e02',
    subjectRecordId: sourceId,
    tagId,
  });
}

function ok(response: HttpResponse, status: number, operation: string) {
  expect(response.status, `${operation}: ${JSON.stringify(response.body)}`).toBe(status);
  return response.body as Record<string, any>;
}

function changedSnapshot(update: (body: Record<string, any>) => void) {
  const body = JSON.parse(new TextDecoder().decode(sourceSnapshot)) as Record<string, any>;
  update(body);
  return new TextEncoder().encode(JSON.stringify(body));
}

test('the producer uses the exact aggregate, source association and Context from a real Kana response', () => {
  const result = candidate();
  expect(result.state).toBe('available');
  if (result.state !== 'available') return;
  expect(result.candidate.contextId).toBe(GLOBAL_CONTEXT);
  expect(result.candidate.statement).toMatchObject({
    property: { id: 'schema:genre' },
    value: { type: 'value', content: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e02' },
    rank: 'normal',
  });
  expect(result.candidate.source).toMatchObject({
    recordId: sourceId,
    tagId: sourceTag,
    amount: '2.59999990463257',
    digest: createHash('sha256').update(sourceSnapshot).digest('hex'),
  });
  expect(result.candidate.statement.qualifiers).toEqual([
    {
      property: { id: 'rezics:sourceTagWeight' },
      value: { type: 'value', content: { amount: '+2.59999990463257', unit: '1' } },
    },
    { property: { id: 'rezics:sourceTagWeightMetric' }, value: { type: 'value', content: 'vndbTagsRating' } },
    { property: { id: 'rezics:spoilerLevel' }, value: { type: 'value', content: { amount: '+2', unit: '1' } } },
  ]);
  expect(
    result.candidate.statement.references.flatMap(({ parts }) => parts.map(({ property }) => property.id)),
  ).toEqual(['schema:url', 'rezics:sourceTagId', 'rezics:sourceSnapshot', 'schema:url']);
  expect(result.candidate.statement.references[1]?.parts[0]?.value.content).toBe(vndbTagsRatingDocumentation);

  const otherContext = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e03';
  const otherAssociation = candidate('g8', 'schema:keywords', otherContext);
  expect(otherAssociation.state).toBe('available');
  if (otherAssociation.state === 'available') {
    expect(otherAssociation.candidate.contextId).toBe(otherContext);
    expect(otherAssociation.candidate.statement.property.id).toBe('schema:keywords');
    expect(otherAssociation.candidate.source.tagId).toBe('g8');
    expect(otherAssociation.candidate.source.amount).toBe('2.34258484840393');
  }
});

test('missing, empty, suppressed and malformed source outcomes stay distinct; individual dump votes are rejected', () => {
  const absent = produceVndbSourceTagWeightCandidate({
    ...{
      requestBody,
      endpoint: vndbTagsRatingEndpoint,
      snapshot: sourceSnapshot,
      subjectId: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01',
      contextId: GLOBAL_CONTEXT,
      property: 'schema:genre',
      conceptId: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e02',
      subjectRecordId: sourceId,
    },
    tagId: 'g999999',
  });
  const base = {
    endpoint: vndbTagsRatingEndpoint,
    requestBody,
    subjectId: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01',
    contextId: GLOBAL_CONTEXT,
    property: 'schema:genre' as const,
    conceptId: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e02',
    subjectRecordId: sourceId,
    tagId: sourceTag,
  };
  const lie = produceVndbSourceTagWeightCandidate({
    ...base,
    snapshot: changedSnapshot((body) => {
      body.results[0].tags.find((tag: Record<string, unknown>) => tag.id === sourceTag).lie = true;
    }),
  });
  const empty = produceVndbSourceTagWeightCandidate({
    ...base,
    snapshot: changedSnapshot((body) => {
      body.results[0].tags.find((tag: Record<string, unknown>) => tag.id === sourceTag).rating = null;
    }),
  });
  const voteOnly = produceVndbSourceTagWeightCandidate({
    ...base,
    snapshot: changedSnapshot((body) => {
      const tag = body.results[0].tags.find((entry: Record<string, unknown>) => entry.id === sourceTag);
      delete tag.rating;
      tag.vote = 2;
    }),
  });
  const zero = produceVndbSourceTagWeightCandidate({
    ...base,
    snapshot: changedSnapshot((body) => {
      body.results[0].tags.find((tag: Record<string, unknown>) => tag.id === sourceTag).rating = 0;
    }),
  });
  const wrongField = produceVndbSourceTagWeightCandidate({
    ...base,
    requestBody: JSON.stringify({
      filters: ['id', '=', sourceId],
      fields: 'id,tags{id,spoiler,lie}',
      results: 1,
    }),
    snapshot: sourceSnapshot,
  });
  const wrongEndpoint = produceVndbSourceTagWeightCandidate({
    ...base,
    endpoint: 'https://vndb.org/api/vn' as typeof vndbTagsRatingEndpoint,
    snapshot: sourceSnapshot,
  });

  expect(absent.state).toBe('absent');
  expect(lie.state).toBe('suppressed');
  expect(empty.state).toBe('empty');
  expect(voteOnly.state).toBe('unavailable');
  expect(zero.state).toBe('unavailable');
  expect(wrongField.state).toBe('unavailable');
  expect(wrongEndpoint.state).toBe('unavailable');
});

test('a released source-weight statement survives native proposal, review, adoption, exact replay and anonymous page read', async () => {
  const concept = await fixture.createSubject('skos:Concept', 'Shared VNDB tag concept');
  const work = await fixture.createSubject('wd:Q689445', 'Source-weighted visual novel');
  const genre = produceVndbSourceTagWeightCandidate({
    endpoint: vndbTagsRatingEndpoint,
    requestBody,
    snapshot: sourceSnapshot,
    subjectId: work.id,
    contextId: GLOBAL_CONTEXT,
    property: 'schema:genre',
    conceptId: concept.id,
    subjectRecordId: sourceId,
    tagId: 'g3',
  });
  const keyword = produceVndbSourceTagWeightCandidate({
    endpoint: vndbTagsRatingEndpoint,
    requestBody,
    snapshot: sourceSnapshot,
    subjectId: work.id,
    contextId: GLOBAL_CONTEXT,
    property: 'schema:keywords',
    conceptId: concept.id,
    subjectRecordId: sourceId,
    tagId: 'g8',
  });
  expect([genre.state, keyword.state]).toEqual(['available', 'available']);
  if (genre.state !== 'available' || keyword.state !== 'available') return;

  const propose = async (statement: unknown, headers = discoveryKey()) => {
    const body = { statement };
    const response = await fixture.request('editor', 'POST', `/v1/subjects/${work.id}/candidates`, body, headers);
    return { response, body, headers };
  };
  const firstProposal = await propose(genre.candidate.statement);
  const proposal = ok(firstProposal.response, 201, 'Propose exact VNDB genre aggregate');
  const replayProposal = await fixture.request(
    'editor',
    'POST',
    `/v1/subjects/${work.id}/candidates`,
    firstProposal.body,
    firstProposal.headers,
  );
  expect(ok(replayProposal, 201, 'Replay exact candidate proposal').candidate).toBe(proposal.candidate);

  const keywordProposal = ok(
    (await propose(keyword.candidate.statement)).response,
    201,
    'Propose the second source tag identity for the same Concept',
  );
  const candidateIds = [proposal.candidate, keywordProposal.candidate] as string[];
  for (const candidateId of candidateIds) {
    ok(
      await fixture.request(
        'acceptor',
        'POST',
        `/v1/subjects/${work.id}/candidates/${candidateId}:accept`,
        { context: GLOBAL_CONTEXT, expected_head: null },
        discoveryKey(),
      ),
      200,
      `Accept ${candidateId}`,
    );
  }

  const adoptionBody = {
    context: GLOBAL_CONTEXT,
    property: 'schema:genre',
    target: concept.id,
    mode: 'replace',
    selection: [{ candidate: proposal.candidate, rank: 'normal' }],
    expected_head: null,
  };
  const adoptionHeaders = discoveryKey();
  const adoptionPath = `/v1/subjects/${work.id}:adopt`;
  const adoption = ok(
    await fixture.request('acceptor', 'POST', adoptionPath, adoptionBody, adoptionHeaders),
    200,
    'Adopt the source-weighted genre',
  );
  const exactReplay = ok(
    await fixture.request('acceptor', 'POST', adoptionPath, adoptionBody, adoptionHeaders),
    200,
    'Replay the exact uncertain adoption command',
  );
  expect(exactReplay).toEqual(adoption);

  const keywordAdoption = ok(
    await fixture.request(
      'acceptor',
      'POST',
      adoptionPath,
      {
        ...adoptionBody,
        property: 'schema:keywords',
        selection: [{ candidate: keywordProposal.candidate, rank: 'normal' }],
      },
      discoveryKey(),
    ),
    200,
    'Adopt the same Concept under its independent source-tag association',
  );
  expect(adoption.revision).toBeGreaterThan(1);
  expect(keywordAdoption.revision).toBeGreaterThan(adoption.revision);
  expect(fixture.release.digest).toBe(bundledDigest);

  const refreshed = produceVndbSourceTagWeightCandidate({
    endpoint: vndbTagsRatingEndpoint,
    requestBody,
    snapshot: changedSnapshot((body) => {
      body.results[0].tags.find((tag: Record<string, unknown>) => tag.id === 'g3').rating = 2.4;
    }),
    subjectId: work.id,
    contextId: GLOBAL_CONTEXT,
    property: 'schema:genre',
    conceptId: concept.id,
    subjectRecordId: sourceId,
    tagId: 'g3',
  });
  expect(refreshed.state).toBe('available');
  if (refreshed.state !== 'available') return;
  expect(refreshed.candidate.source.amount).toBe('2.4');
  expect(refreshed.candidate.source.digest).not.toBe(genre.candidate.source.digest);
  const refreshRequest = await propose(refreshed.candidate.statement);
  const refreshProposal = ok(refreshRequest.response, 201, 'Propose the changed source revision');
  expect(refreshProposal.candidate).not.toBe(proposal.candidate);

  const readPage = async (persona: 'anonymous' | 'alice') =>
    ok(
      await fixture.request(persona, 'POST', '/v1/pages:read', {
        target: { subject: work.id },
        languages: ['en'],
      }),
      200,
      `Read disclosed tags as ${persona}`,
    );
  const publicPage = await readPage('anonymous');
  const privatePage = await readPage('alice');
  const subjectRead = (page: Record<string, any>) =>
    Object.values(page.reads as Record<string, any>).find(
      (result) => result.status === 200 && result.body?.subject?.id === work.id,
    )?.body;
  const publicSubject = subjectRead(publicPage);
  const privateSubject = subjectRead(privatePage);
  expect(publicSubject?.related[concept.id]?.labels.en).toBe('Shared VNDB tag concept');
  expect(publicSubject?.subject.statements['schema:genre']).toHaveLength(1);
  expect(publicSubject?.subject.statements['schema:keywords']).toHaveLength(1);
  expect(publicSubject?.subject.statements['schema:genre']).toEqual(privateSubject?.subject.statements['schema:genre']);
  expect(publicSubject?.subject.statements['schema:keywords']).toEqual(
    privateSubject?.subject.statements['schema:keywords'],
  );
  expect(publicPage.actions?.status).toBe('denied');
  expect(publicPage.actions).not.toEqual(privatePage.actions);

  const genreFact = publicSubject.subject.statements['schema:genre'][0];
  const keywordFact = publicSubject.subject.statements['schema:keywords'][0];
  expect(genreFact.value.content).toBe(concept.id);
  expect(keywordFact.value.content).toBe(concept.id);
  const facts = (statement: any) => ({
    qualifiers: statement.qualifiers.map((part: any) => [part.property.id, part.value]),
    references: statement.references.map((group: any) =>
      group.parts.map((part: any) => [part.property.id, part.value]),
    ),
  });
  const proposedFacts = (statement: any) => ({
    qualifiers: statement.qualifiers.map((part: any) => [part.property.id, part.value]),
    references: statement.references.map((group: any) =>
      group.parts.map((part: any) => [part.property.id, part.value]),
    ),
  });
  expect(facts(genreFact)).toEqual(proposedFacts(genre.candidate.statement));
  expect(facts(keywordFact)).toEqual(proposedFacts(keyword.candidate.statement));
  expect(
    genreFact.qualifiers.find((part: any) => part.property.id === 'rezics:sourceTagWeight')?.value.content.amount,
  ).toBe('+2.59999990463257');
  expect(JSON.stringify(publicSubject.subject.statements)).not.toMatch(/confidence|vote|popularity/i);
  expect(createHash('sha256').update(sourceSnapshot).digest('hex')).toBe(genre.candidate.source.digest);
});
