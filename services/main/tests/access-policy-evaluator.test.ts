import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import {
  compilePolicyRules, decidePolicy, EvaluationBudget, parseCondition, type PolicyFacts, type Truth,
} from '../src/modules/access/policy-evaluator.ts';
import { PolicyInvalid } from '../src/modules/access/policy-errors.ts';

const admission = randomUUID();
const facts = (membership: Truth, overrides: Partial<PolicyFacts> = {}): PolicyFacts & { unavailable: number } => {
  const state = { unavailable: 0 };
  return Object.assign(state, {
    actingSubject: 'https://rezics.com/id/00000000-0000-0000-0000-000000000001', now: new Date(),
    authenticated: async () => true, represents: async () => true, hasGrant: async () => true,
    memberOf: async () => { if (membership === 'unknown') state.unavailable++; return membership; },
    ...overrides });
};
const limits = { maxStates: 64, maxInputRows: 64, deadlineMs: 1000 };

test('IAM17/IAM22 unit: Kleene conditions keep unknown evidence unresolved', async () => {
  const { rules } = compilePolicyRules([{ ruleId: randomUUID(), actions: ['work.edit'], condition: { op: 'represents' } }], [
    { ruleId: randomUUID(), actions: ['work.edit'], effect: 'allow',
      condition: { op: 'not', arg: { op: 'member-of', admission, basis: 'acting_subject' } } },
    { ruleId: randomUUID(), actions: ['work.edit'], effect: 'allow', condition: { op: 'has-grant', action: 'work.edit' } },
  ]);
  const decide = (evidence: PolicyFacts & { unavailable: number }) =>
    decidePolicy(rules, 'work.edit', evidence, new EvaluationBudget(limits), () => evidence.unavailable);
  expect((await decide(facts(false))).outcome).toBe('allow');
  const unknown = await decide(facts('unknown'));
  expect([unknown.outcome, unknown.reason]).toEqual(['indeterminate', 'set-admission-unavailable']);
  expect((await decide(facts(true))).deciding?.position).toBe(2);
  const guarded = await decide(facts('unknown', { represents: async () => false }));
  expect([guarded.outcome, guarded.reason]).toEqual(['deny', 'mandatory-guard-failed']);
  // any(true, unknown) is true; all(false, unknown) is false; otherwise unknown survives.
  const any = parseCondition({ op: 'any', args: [{ op: 'authenticated' },
    { op: 'member-of', admission, basis: 'acting_subject' }] });
  const { rules: anyRules } = compilePolicyRules([], [{ ruleId: randomUUID(), actions: ['work.edit'],
    effect: 'allow', condition: any }]);
  const evidence = facts('unknown');
  expect((await decidePolicy(anyRules, 'work.edit', evidence, new EvaluationBudget(limits),
    () => evidence.unavailable)).outcome).toBe('allow');
  const exhausted = await decidePolicy(anyRules, 'work.edit', facts(false),
    new EvaluationBudget({ ...limits, maxStates: 1 }), () => 0);
  expect([exhausted.outcome, exhausted.reason]).toEqual(['indeterminate', 'budget-exhausted']);
});

test('IAM16/IAM19 unit: the compiler admits only the closed registry and one meaning per set', () => {
  for (const condition of [{ op: 'sql', text: 'SELECT 1' }, { op: 'authenticated', extra: true },
    { op: 'member-of', admission: 'not-a-uuid', basis: 'acting_subject' },
    { op: 'all', args: [] }, JSON.parse('{"op":"not","arg":'.repeat(10) + '{"op":"authenticated"}' + '}'.repeat(10))]) {
    expect(() => parseCondition(condition)).toThrow(PolicyInvalid);
  }
  const ruleId = randomUUID();
  const member = { op: 'member-of', admission, basis: 'acting_subject' };
  expect(() => compilePolicyRules([], [{ ruleId, actions: ['work.edit'], effect: 'deny',
    condition: { op: 'any', args: [member, { op: 'not', arg: member }] } }])).toThrow(PolicyInvalid);
  expect(() => compilePolicyRules([], [{ ruleId, actions: ['*'], effect: 'allow',
    condition: { op: 'authenticated' } }])).toThrow(PolicyInvalid);
  const { references } = compilePolicyRules([{ ruleId: randomUUID(), actions: ['work.edit'],
    condition: { op: 'not', arg: member } }], [{ ruleId, actions: ['work.edit'], effect: 'allow', condition: member }]);
  expect(references.map(reference => reference.polarity)).toEqual(['exclude', 'include']);
});
