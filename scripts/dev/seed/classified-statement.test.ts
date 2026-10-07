import { expect, test } from 'bun:test';
import { CLASSIFICATION_PROPOSITION_PROFILE } from '../../../services/main/src/modules/classification/proposition.ts';
import { CLASSIFIED_AS } from '../../../services/main/src/modules/statement/schema.ts';
import { classificationAlreadyAccepted, classificationContextBody, classifiedStatementBody,
  expectedLocalDecisionHead, rejectionRevises, statementAcceptance, statementDecisionBody } from './classified-statement.ts';

const actor = 'https://rezics.com/id/019d0000-0000-7000-8000-000000000001';
const concept = 'https://rezics.com/id/019d0000-0000-7000-8000-000000000002';
const other = 'https://rezics.com/id/019d0000-0000-7000-8000-000000000003';
const definition = 'https://rezics.com/id/019d0000-0000-7000-8000-000000000004';
const mainVersion = 'https://rezics.com/id/019d0000-0000-7000-8000-000000000005';
const realm = 'https://rezics.com/id/019d0000-0000-7000-8000-000000000006';
const context = { context: 'https://rezics.com/id/019d0000-0000-7000-8000-000000000007',
  semanticRevision: 'https://rezics.com/id/019d0000-0000-7000-8000-000000000008' };

test('a classification Context defines classifiedAs for each Concept in a stable order', () => {
  const body = classificationContextBody(actor, [
    { concept: other, definitionRevision: definition },
    { concept, definitionRevision: definition },
  ]);
  expect(body.entries.map(entry => entry.target)).toEqual([concept, other]);
  expect(body.entries.every(entry => entry.relation === CLASSIFIED_AS && entry.state === 'defined'
    && entry.applicability.length === 0)).toBe(true);
  expect(body).toMatchObject({ role: 'shared', disclosure: 'public', base: null, actingSubject: actor });
});

test('a classified Statement names the Main version, the Concept and the shared Context', () => {
  expect(classifiedStatementBody(actor, mainVersion, concept, context)).toEqual({
    profile: 'statement-v1', speaker: { kind: 'personal' }, subject: mainVersion,
    predicate: CLASSIFIED_AS, relationDefinition: CLASSIFICATION_PROPOSITION_PROFILE,
    value: { kind: 'resource', iri: concept }, applicability: [],
    interpretation: { kind: 'explicit', context: context.context, semanticRevision: context.semanticRevision },
    evidence: [], actingSubject: actor,
  });
});

test('acceptance is Global or the Realm, and an inherited Global head is not revised as local', () => {
  expect(statementAcceptance({ kind: 'global' })).toEqual({ kind: 'global' });
  expect(statementAcceptance({ kind: 'realm-classification', id: realm })).toEqual({ kind: 'realm', realm });
  expect(classificationAlreadyAccepted({ state: 'accepted', source: 'global' }, { kind: 'global' })).toBe(true);
  expect(classificationAlreadyAccepted({ state: 'accepted', source: 'inherited-global' },
    { kind: 'realm-classification', id: realm })).toBe(false);
  expect(classificationAlreadyAccepted({ state: 'accepted', source: 'local' },
    { kind: 'realm-classification', id: realm })).toBe(true);
  expect(expectedLocalDecisionHead({ source: 'local', decision: definition })).toBe(definition);
  expect(expectedLocalDecisionHead({ source: 'global', decision: definition })).toBeNull();
  expect(expectedLocalDecisionHead({ source: 'inherited-global', decision: definition })).toBeNull();
});

test('a rejection revises the accepted head, and a fresh slot is not rejected', () => {
  expect(rejectionRevises({ state: 'accepted', source: 'global', decision: definition }, { kind: 'global' })).toBe(true);
  expect(rejectionRevises({ state: 'absent', source: 'none', decision: null }, { kind: 'global' })).toBe(false);
  expect(rejectionRevises({ state: 'accepted', source: 'inherited-global', decision: definition },
    { kind: 'realm-classification', id: realm })).toBe(false);
  const statement = { statement: concept, meaningKey: 'urn:rezics:meaning:ab' };
  expect(statementDecisionBody(actor, statement, { kind: 'global' }, 'rejected', definition)).toMatchObject({
    profile: 'statement-decision-v1', target: { kind: 'qualified-fact', meaningKey: statement.meaningKey,
      support: [statement.statement] }, acceptance: { kind: 'global' }, outcome: 'rejected',
    expectedDecisionHead: definition,
  });
});
