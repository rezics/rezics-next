import { expect, test } from 'bun:test';
import { groupAdmittedStatements, type AdmittedGroupRow,
  type GroupedStatementCondition } from '../../../services/main/src/modules/work/search-grouped.ts';
import { PublicQueryBudgetExceeded, PublicQueryUnavailable }
  from '../../../services/main/src/modules/work/search-budget.ts';

const id = (number: number) => `https://rezics.com/id/${String(number).padStart(8, '0')}-1111-4111-8111-111111111111`;
const release = id(80), canon = id(81), time = id(82);
const qualifiers = [release, canon, time];
const red = id(90), blue = id(91), female = id(92);
const hair = id(93), gender = id(94), hairDefinition = id(95), genderDefinition = id(96);
const semanticRevision = id(97), alternateRevision = id(98);
const condition = (predicate: string, relationDefinition: string, value: string): GroupedStatementCondition => ({
  predicate, relationDefinition, value, interpretationDefinition: id(99),
  semanticRevision, applicability: qualifiers,
});
const conditions = [condition(gender, genderDefinition, female), condition(hair, hairDefinition, red)];
function row(work: number, participant: number, occurrence: number, statement: number,
  predicate: string, relationDefinition: string, value: string,
  options: { qualifiers?: string[]; semanticRevision?: string; meaningKey?: string;
    interpretationDefinition?: string } = {}): AdmittedGroupRow {
  const app = options.qualifiers ?? qualifiers;
  return { work: id(work), mainVersion: id(work + 1000), matchUnit: id(work + 2000), score: 2.5,
    occurrence: id(occurrence), participant: id(participant), applicability: app,
    acceptanceContext: id(3000), statement: {
      statement: id(statement), subject: id(participant), predicate, relationDefinition,
      value: { kind: 'resource', iri: value }, speaker: id(4000),
      meaningKey: options.meaningKey ?? `urn:rezics:meaning:${String(statement).padStart(64, '0')}`,
      revision: id(statement + 5000), applicability: app,
      meaningBasis: { state: 'readable', context: id(5000),
        semanticRevision: options.semanticRevision ?? semanticRevision,
        interpretationDefinitions: [options.interpretationDefinition ?? id(99)] },
      sourcePosition: { datasetId: 'product', dataEpoch: 'epoch', sequence: '7' },
    } };
}

test('SEARCH01: two conditions bind the same participant, occurrence, release, canon and time', () => {
  const facts = [
    row(1, 10, 20, 30, gender, genderDefinition, female),
    row(1, 10, 20, 31, hair, hairDefinition, red),
    // A red supporting character cannot complete the female lead's conditions.
    row(1, 11, 21, 32, hair, hairDefinition, red),
    // A female in a different Work cannot combine with that red character.
    row(2, 12, 22, 33, gender, genderDefinition, female),
    row(2, 12, 22, 34, hair, hairDefinition, blue),
    // The same visible value with a different interpretation criterion does not qualify.
    row(3, 13, 23, 35, gender, genderDefinition, female),
    row(3, 13, 23, 36, hair, hairDefinition, red,
      { semanticRevision: alternateRevision, interpretationDefinition: id(100) }),
    // A release/canon/time mismatch is not silently broadened.
    row(4, 14, 24, 37, gender, genderDefinition, female),
    row(4, 14, 24, 38, hair, hairDefinition, red,
      { qualifiers: [release, canon, id(83)] }),
  ];
  const result = groupAdmittedStatements(facts, conditions, 'work', 'fully-filtered');
  expect(result).toMatchObject({ complete: true, countPrecision: 'exact', total: 1 });
  expect(result.groups.map(group => [group.work, group.participant, group.occurrence]))
    .toEqual([[id(1), id(10), id(20)]]);
  expect(result.facets[1]?.values).toEqual([{ value: red, count: 1 }]);
  expect(groupAdmittedStatements(facts, conditions, 'work', 'self-filter-excluding').facets[1]?.values)
    .toEqual([{ value: red, count: 2 }, { value: blue, count: 1 }]);
});

test('SEARCH04: exact definitions shared by Context revisions group meaning without pooling supports', () => {
  const sharedKey = 'urn:rezics:meaning:shared';
  const facts = [
    row(1, 10, 20, 30, gender, genderDefinition, female),
    row(1, 10, 20, 31, hair, hairDefinition, red, { meaningKey: sharedKey }),
    row(1, 10, 20, 32, hair, hairDefinition, red,
      { semanticRevision: alternateRevision, meaningKey: sharedKey }),
    row(1, 10, 20, 33, hair, hairDefinition, red,
      { semanticRevision: alternateRevision, interpretationDefinition: id(100) }),
  ];
  const result = groupAdmittedStatements(facts, conditions, 'qualifiedFact', 'fully-filtered');
  expect(result.total).toBe(2);
  expect(result.groups[0]?.facts.find(fact => fact.predicate === hair)?.supportingStatements)
    .toEqual([id(31), id(32)]);
  const alternate = [conditions[0]!, { ...conditions[1]!, interpretationDefinition: id(100),
    semanticRevision: alternateRevision }];
  const separate = groupAdmittedStatements(facts, alternate, 'qualifiedFact', 'fully-filtered');
  expect(separate.total).toBe(2);
  expect(separate.groups[0]?.facts.find(fact => fact.predicate === hair)?.supportingStatements)
    .toEqual([id(33)]);
});

test('SEARCH04: overlapping occurrences deduplicate Work, participant and qualified-fact counts', () => {
  const facts = [
    row(1, 10, 20, 30, gender, genderDefinition, female),
    row(1, 10, 20, 31, hair, hairDefinition, red),
    row(1, 10, 20, 32, hair, hairDefinition, red,
      { meaningKey: `urn:rezics:meaning:${String(31).padStart(64, '0')}` }),
    row(1, 10, 21, 30, gender, genderDefinition, female),
    row(1, 10, 21, 31, hair, hairDefinition, red),
    row(2, 11, 22, 33, gender, genderDefinition, female),
    row(2, 11, 22, 34, hair, hairDefinition, red),
  ];
  const totals = ['work', 'participant', 'occurrence', 'qualifiedFact', 'supportingStatement']
    .map(grain => groupAdmittedStatements(facts, conditions,
      grain as Parameters<typeof groupAdmittedStatements>[2], 'fully-filtered').total);
  expect(totals).toEqual([2, 2, 3, 4, 5]);
  const result = groupAdmittedStatements(facts, conditions, 'qualifiedFact', 'fully-filtered');
  expect(result.groups[0]?.facts.find(fact => fact.predicate === hair)?.supportingStatements)
    .toEqual([id(31), id(32)]);
  expect(result.groups[0]?.score).toBe(2.5);
});

test('SEARCH10: grouped owner positions and relation budgets fail closed before exact facets', () => {
  const facts = [row(1, 10, 20, 30, gender, genderDefinition, female),
    row(1, 10, 20, 31, hair, hairDefinition, red)];
  const moved = structuredClone(facts);
  moved[1]!.statement.sourcePosition.sequence = '8';
  expect(() => groupAdmittedStatements(moved, conditions, 'work', 'fully-filtered'))
    .toThrow(PublicQueryUnavailable);
  expect(() => groupAdmittedStatements(Array.from({ length: 21 }, (_, index) =>
    row(index + 1, index + 100, index + 200, index + 300, hair, hairDefinition, red)),
  conditions, 'work', 'fully-filtered')).toThrow(PublicQueryBudgetExceeded);
});
