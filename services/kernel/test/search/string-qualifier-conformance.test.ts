import { expect, test } from 'bun:test';
import { admitFilter, parseFilter } from '@rezics/filter';
import { compileFilter } from '../../src/search/filter.ts';
import { compileCurrentFilter } from '../../src/search/current-filter-plan.ts';
import { holdsCurrentStatements, holdsCurrentType } from '../../src/search/current-leaf.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import {
  digestA,
  digestB,
  freeText,
  reading,
  snak,
  stringQualifierFixture,
} from '../semantic/string-qualifier-source.test.ts';

test('source to real index and current matcher agree on crossed string and item qualifier tuples without coercion', async () => {
  const f = await stringQualifierFixture();
  const url = process.env.OPENSEARCH_URL;
  if (!url) throw new Error('OPENSEARCH_URL must name the check node');
  const client = createOpenSearch(url);
  const prefix = `string-${crypto.randomUUID().slice(0, 8)}-`;
  const index = subjectIndexName(prefix, 1);
  let created = false;
  try {
    const methodA = (await f.create([], 'skos:Concept')).id as string;
    const methodB = (await f.create([], 'skos:Concept')).id as string;
    const crossed = await f.create([reading('en', digestA, methodA), reading('ja', digestB, methodB)]);
    const exact = await f.create();
    await f.adopt(exact.id, reading('en', digestB, methodA));
    const absent = await f.create([snak('ex:reading', 'B2')]);
    // All these controls contain only concrete public evidence with a known finite selection.
    // They are primitive conformance, not public negative/privacy certification by SubjectSource.
    const subjects = [crossed, exact, absent];
    const snapshots = await Promise.all(subjects.map(({ id }) => f.read(id)));
    await createSubjectIndex(client, prefix, 1);
    created = true;
    for (const snapshot of snapshots) {
      await client.bulk(
        bulkLines(
          index,
          documentActions(
            snapshot,
            snapshot.subjects.map(({ id }) => id),
          ),
        ),
        { query: { refresh: 'wait_for' } },
      );
    }
    const qualified = (language: string, digest: string, method: string, text = freeText) => ({
      statement: {
        property: 'ex:reading',
        in: ['A1'],
        qualifiers: [
          { property: 'ex:language', in: [language] },
          { property: 'ex:digest', in: [digest] },
          { property: 'ex:method', in: [method] },
          { property: 'ex:text', in: [text] },
        ],
      },
    });
    const run = async (input: unknown, expected: string[]) => {
      const filter = admitFilter(parseFilter(input), f.release);
      const compiled = compileFilter(filter, { prefix: 'q' });
      const result = await client.request<{ hits: { hits: { _id: string }[] } }>('POST', `${index}/_search`, {
        size: 20,
        query: compiled.query,
      });
      expect(result.body.hits.hits.map(({ _id }) => _id).sort()).toEqual([...expected].sort());
      const plan = compileCurrentFilter(filter);
      const matches = snapshots
        .flatMap(({ subjects }) => subjects)
        .filter(
          (subject) =>
            plan.evaluate(
              plan.leaves.map((clause) =>
                clause.facet === 'type'
                  ? holdsCurrentType(subject.type, clause)
                  : holdsCurrentStatements(subject.statements, clause),
              ),
            ) === true,
        )
        .map(({ id }) => id);
      expect(matches.sort()).toEqual([...expected].sort());
    };
    await run(qualified('en', digestA, methodA), [crossed.id]);
    await run(qualified('ja', digestB, methodB), [crossed.id]);
    await run(qualified('en', digestB, methodA), [exact.id]);
    await run(qualified('ja', digestA, methodA), []);
    await run(qualified('en', digestA, methodB), []);
    for (const text of [freeText.trim(), freeText.normalize('NFC'), freeText.toUpperCase()])
      await run(qualified('en', digestA, methodA, text), []);
    const multi = qualified('en', digestA, methodA);
    multi.statement.qualifiers[0]!.in = ['en', 'ja'];
    multi.statement.qualifiers[1]!.in = [digestA, digestB];
    await run(multi, [crossed.id, exact.id]);
    await run({ not: qualified('en', digestB, methodA) }, [crossed.id, absent.id]);
    await run({ and: [{ type: { in: ['ex:Sample'] } }, qualified('en', digestA, methodA)] }, [crossed.id]);
    // The existing Boolean boundary retains uncertainty; these vectors are not native API unknown proof.
    for (const property of ['ex:language', 'ex:digest', 'ex:method']) {
      const plan = compileCurrentFilter(
        admitFilter(
          parseFilter({
            not: {
              statement: {
                property: 'ex:reading',
                in: ['A1'],
                qualifiers: [
                  { property, in: [property === 'ex:method' ? methodA : property === 'ex:digest' ? digestA : 'en'] },
                ],
              },
            },
          }),
          f.release,
        ),
      );
      expect(plan.evaluate(['not_proven'])).toBe('not_proven');
      expect(plan.evaluate([false])).toBe(true);
      expect(plan.evaluate([true])).toBe(false);
    }
  } finally {
    if (created) await client.request('DELETE', index);
    await f.close();
  }
});
