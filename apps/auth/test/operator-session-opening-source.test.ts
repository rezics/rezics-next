import { expect, test } from 'bun:test';
import { parseOpeningSource, type OpeningInput } from '../src/operator-session-opening';

const human = '00000000-0000-8000-8000-000000000001';
const operator = '00000000-0000-8000-8000-000000000002';
const subject = '00000000-0000-8000-8000-000000000003';
const reservation = '00000000-0000-8000-8000-000000000004';
const foreign = '00000000-0000-8000-8000-000000000005';
const input: OpeningInput = {
  accountId: human,
  operationKey: 'opening-confirmation',
  operation: { kind: 'opening', operatorAccountId: operator, subjectAccountId: subject },
};
const metadata = {
  account: { id: subject, kind: 'actor', handle: 'actual_actor', displayName: 'Actual actor' },
  operator: { id: operator, kind: 'organization', handle: 'actual_operator', displayName: 'Actual operator' },
  relation: { operatorAccountId: operator, reservationId: reservation, version: '7' },
  self: false,
  role: null,
  members: { state: 'denied', items: [], next: null },
  responsibilities: null,
};
const relation = {
  previous: { operatorAccountId: operator, subjectAccountId: subject, reservationId: reservation },
  expectedVersion: '7',
};

test('opening confirmation requires the delivered native relation and authorized identity metadata to agree', () => {
  expect(parseOpeningSource(metadata, relation, input)).toEqual({
    kind: 'ready',
    metadata: { subject: metadata.account, operator: metadata.operator },
  });
  for (const source of [
    null,
    {},
    { error: 'account_management_read_unavailable' },
    { ...relation, previous: { ...relation.previous, subjectAccountId: foreign } },
    { ...relation, previous: { ...relation.previous, operatorAccountId: foreign } },
    { ...relation, previous: { ...relation.previous, reservationId: foreign } },
    { ...relation, expectedVersion: '8' },
    { ...relation, authorization: 'invented' },
    { ...relation, previous: { ...relation.previous, scope: ['account:manage'] } },
  ])
    expect(parseOpeningSource(metadata, source, input)).toEqual({ kind: 'unavailable' });
  expect(parseOpeningSource({ ...metadata, operator: null }, relation, input)).toEqual({ kind: 'unavailable' });
  expect(
    parseOpeningSource(metadata, relation, {
      ...input,
      operation: { ...input.operation, operatorAccountId: foreign },
    }),
  ).toEqual({ kind: 'unavailable' });
});
