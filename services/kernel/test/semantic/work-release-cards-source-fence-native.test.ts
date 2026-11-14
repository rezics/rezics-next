import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BatchStatement, Source } from '@rezics/definitions/bulk';
import type { HttpResponse } from '../../../../specs/semantic-driver.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  discoveryStatement,
  type CreatedSubject,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';

const fixturePromise = createReleasedDiscoveryFixture({ version: 1 });
let fixture: ReleasedDiscoveryFixture;

function body(response: HttpResponse, status = 200) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  return response.body as Record<string, any>;
}

async function card(work: CreatedSubject, edition: CreatedSubject) {
  const query = new URLSearchParams({ property: 'schema:exampleOfWork', limit: '20', language: 'en' });
  const result = body(await fixture.request('anonymous', 'GET', `/v1/subjects/${work.id}/links?${query}`));
  expect(result.workReleaseCards.state).toBe('available');
  return (result.workReleaseCards.cards as Record<string, any>[]).find(({ subject }) => subject === edition.id)!;
}

function importedStatement(property: string, content: unknown, citation: string): BatchStatement {
  return {
    property: { id: property },
    value: { type: 'value', content },
    references: [
      {
        parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: citation } }],
      },
    ],
  };
}

async function importAndAdopt(
  importer: Awaited<ReturnType<ReleasedDiscoveryFixture['reviewedCatalogueOperator']>>,
  edition: CreatedSubject,
  source: Source,
  attempt: number,
) {
  const dateCitation = `https://example.org/card-source/${attempt}/date`;
  const languageCitation = `https://example.org/card-source/${attempt}/language`;
  const result = await importer.batch({
    commands: [
      {
        op: 'propose',
        key: `card-date-${attempt}`,
        source,
        subject: edition.id,
        statement: importedStatement('schema:datePublished', {
          time: '+2024-03-17T00:00:00Z',
          precision: 11,
        }, dateCitation),
      },
      {
        op: 'propose',
        key: `card-language-${attempt}`,
        source,
        subject: edition.id,
        statement: importedStatement('schema:inLanguage', 'ja', languageCitation),
      },
    ],
  });
  const ids = new Map(
    result.results.map((row) => {
      if (row.status !== 201 || !('value' in row) || !('candidate' in row.value))
        throw new Error(`Imported card proposal failed: ${JSON.stringify(row)}`);
      return [row.key, row.value.candidate];
    }),
  );

  for (const [property, candidate] of [
    ['schema:datePublished', ids.get(`card-date-${attempt}`)!],
    ['schema:inLanguage', ids.get(`card-language-${attempt}`)!],
  ] as const) {
    const page = await importer.reviewedCandidates(edition.id, { property, context: GLOBAL_CONTEXT, limit: 20 });
    const row = page.candidates.find((candidateRow) => candidateRow.id === candidate);
    if (!row || !('statement' in row) || !row.source) throw new Error(`Missing imported ${property} candidate`);
    expect(row.source).toEqual(source);
    await importer.acceptReviewedCandidate(
      edition.id,
      candidate,
      { context: GLOBAL_CONTEXT, expected_head: row.head },
      randomUUID(),
    );
    await importer.adoptReviewedCandidates(
      edition.id,
      {
        context: GLOBAL_CONTEXT,
        property,
        mode: 'replace',
        selection: [{ candidate, rank: 'normal' }],
        expected_head: page.adoption?.head ?? null,
      },
      randomUUID(),
    );
  }
  return { dateCitation, languageCitation };
}

afterAll(async () => {
  fixture ??= await fixturePromise;
  await fixture.close();
});

test('native release cards withhold a taken imported scalar tuple and retain other selected facts', async () => {
  fixture = await fixturePromise;
  const work = await fixture.createSubject('schema:Book', 'Source-fenced edition work');
  const edition = await fixture.createSubject('bf:Instance', 'Source-fenced imported edition');
  const membership = await fixture.adopt(edition, discoveryStatement('schema:exampleOfWork', work.id));
  const importer = await fixture.reviewedCatalogueOperator('alice');
  await fixture.grantAccount('alice', ['source_fence:takedown']);

  let selected: { source: Source; dateCitation: string; languageCitation: string } | undefined;
  const subjectHomes = new Set([
    partitionOf(routeOf(work.id)!),
    partitionOf(routeOf(edition.id)!),
  ]);
  for (let attempt = 0; attempt < 16 && !selected; attempt++) {
    const source: Source = {
      source: 'card-fence',
      external_id: `edition-${randomUUID()}`,
      record_revision: String(attempt + 1),
      digest: 'a'.repeat(64),
      converter_revision: 'card-fence-v1',
      field_group: 'facts',
    };
    const citations = await importAndAdopt(importer, edition, source, attempt);
    await fixture.catchUp([work, edition]);
    const before = await card(work, edition);
    expect(before.membership.id).toBe(membership.candidate);
    expect(before.fields['schema:datePublished'].statements[0].references[0].parts[0].value.content).toBe(
      citations.dateCitation,
    );
    expect(before.fields['schema:inLanguage'].statements[0].value.content).toBe('ja');
    expect(before.fields['schema:inLanguage'].statements[0].references[0].parts[0].value.content).toBe(
      citations.languageCitation,
    );

    body(
      await fixture.request(
        'alice',
        'POST',
        '/v1/sourceFences:takedown',
        {
          source: source.source,
          externalId: source.external_id,
          fieldGroup: source.field_group,
          reason: 'Release-card native source-fence acceptance',
        },
        discoveryKey(),
      ),
    );
    const stored = await fixture.inspect<{ route: number }>(
      `SELECT route FROM content.source_fences
       WHERE source = $1 AND external_id = $2 AND field_group = $3`,
      [source.source, source.external_id, source.field_group],
    );
    expect(stored.rows).toHaveLength(1);
    const sourceHome = partitionOf(stored.rows[0]!.route);
    if (!subjectHomes.has(sourceHome))
      selected = { source, ...citations };
  }
  expect(selected).toBeDefined();

  const after = await card(work, edition);
  expect(after.membership.id).toBe(membership.candidate);
  expect(after.fields['schema:datePublished'].state).toBe('withheld');
  expect(after.fields['schema:inLanguage'].state).toBe('withheld');
  const serialized = JSON.stringify(after);
  expect(serialized).not.toContain('+2024-03-17T00:00:00Z');
  expect(serialized).not.toContain(selected!.dateCitation);
  expect(serialized).not.toContain(selected!.languageCitation);

  const repeated = await card(work, edition);
  expect(repeated.fields['schema:datePublished'].state).toBe('withheld');
  expect(repeated.fields['schema:inLanguage'].state).toBe('withheld');
  expect(JSON.stringify(repeated)).not.toContain(selected!.dateCitation);
  expect(JSON.stringify(repeated)).not.toContain(selected!.languageCitation);

  const independent = await fixture.adopt(edition, discoveryStatement('schema:inLanguage', 'en'));
  await fixture.catchUp([work, edition]);
  const permitted = await card(work, edition);
  expect(permitted.membership.id).toBe(membership.candidate);
  expect(permitted.fields['schema:datePublished'].state).toBe('withheld');
  expect(permitted.fields['schema:inLanguage'].state).toBe('available');
  expect(permitted.fields['schema:inLanguage'].statements.map(({ id }: any) => id)).toEqual([independent.candidate]);
  expect(permitted.fields['schema:inLanguage'].statements[0].rezics.revision).toBe(independent.revision);
});
