import { expect, test } from 'bun:test';
import { parseOpeningRelation, type OpeningInput } from '../src/operator-session-opening';

const human = '00000000-0000-8000-8000-000000000001';
const operator = '00000000-0000-8000-8000-000000000002';
const subject = '00000000-0000-8000-8000-000000000003';
const reservation = '00000000-0000-8000-8000-000000000004';
const input: OpeningInput = {
  accountId: human,
  operationKey: 'opening-confirmation',
  operation: { kind: 'opening', operatorAccountId: operator, subjectAccountId: subject },
};
const relation = {
  previous: { operatorAccountId: operator, subjectAccountId: subject, reservationId: reservation },
  expectedVersion: '7',
};

test('the native relation alone identifies the selected operated actor and operator without inventing names or operator kind', () => {
  expect(parseOpeningRelation(relation, input)).toEqual({
    kind: 'ready',
    metadata: {
      subject: { id: subject, kind: 'actor', handle: null, displayName: null },
      operator: { id: operator, kind: null, handle: null, displayName: null },
    },
  });
  for (const source of [
    null,
    {},
    { error: 'account_management_read_unavailable' },
    { ...relation, previous: { ...relation.previous, subjectAccountId: human } },
    { ...relation, previous: { ...relation.previous, operatorAccountId: human } },
    { ...relation, previous: { ...relation.previous, reservationId: '' } },
    { ...relation, previous: { ...relation.previous, displayName: 'Invented name' } },
    { ...relation, expectedVersion: '07' },
    { ...relation, expectedVersion: -1 },
    { ...relation, approval: 'invented' },
  ])
    expect(parseOpeningRelation(source, input)).toEqual({ kind: 'unavailable' });
});
