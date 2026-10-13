import { expect, test } from 'bun:test';
import { personaNames, personaSessions } from '../support/personas.ts';
import { effectClosure, publishClosureRule } from './outcomes/realm/closure-fixture.ts';

type Evidence = {
  caller: string | null; actingSubject: string | null;
  requestedAt: string; answeredAt: string;
  method: string; path: string; body?: unknown; idempotencyKey?: string;
  answer: { status: number; body: string };
};
type GrantInput = { action: string; grantId: string; validUntil: string; expectedAuthorityEpoch: string };
type GrantAnswer = { authorityEpoch: string; grant: { id: string; active: boolean; validUntil: string } };
type RuleInput = { ref: string; scopeId: string; actingSubject: string; idempotencyKey: string };

test('closure publication consumes live bounded authority for replay, expiry and revocation', async () => {
  const started = performance.now();
  const sessions = await personaSessions('public');
  const requests: Evidence[] = [];
  let phase = 'publisher-lifetime';
  for (const name of personaNames) {
    const person = sessions[name];
    const call = person.main;
    person.main = async (method, path, body, idempotencyKey, options) => {
      const requestedAt = new Date().toISOString();
      const response = await call(method, path, body, idempotencyKey, options);
      const answeredAt = new Date().toISOString();
      requests.push({ caller: person.accountId, actingSubject: person.actingSubject,
        requestedAt, answeredAt, method, path, body, idempotencyKey,
        answer: { status: response.status, body: await response.clone().text() } });
      return response;
    };
  }
  try {
    const rule = await publishClosureRule(sessions);
    const changes = requests.filter(request => request.method === 'POST'
      && request.path === '/v1/access/grant-changes');
    const grants = changes.filter(request => (request.body as GrantInput).action === 'create');
    expect(grants).toHaveLength(3);
    const rules = requests.filter(request => request.method === 'POST' && request.path === '/v1/governance/rules');
    for (const [index, issuance] of grants.entries()) {
      const input = issuance.body as GrantInput;
      const grant = JSON.parse(issuance.answer.body) as GrantAnswer;
      expect(issuance.answer.status).toBe(200);
      expect(grant.grant).toMatchObject({ id: input.grantId, active: true, validUntil: input.validUntil });
      expect(grant.authorityEpoch).not.toBe(input.expectedAuthorityEpoch);
      const publication = rules.filter(request => request.answer.status === 201)[index]!;
      const command = publication.body as RuleInput;
      const episode = rules.filter(request => (request.body as RuleInput).ref === command.ref);
      expect(episode.map(request => request.answer.status)).toEqual(index < 2 ? [201, 200, 403] : [201, 200]);
      expect(command).toMatchObject({ scopeId: 'governance:platform', actingSubject: sessions.operator.actingSubject });
      expect(JSON.parse(episode[1]!.answer.body)).toEqual({ ...JSON.parse(publication.answer.body), replayed: true });
      for (const live of episode.slice(0, 2)) {
        expect(live.caller).toBe(sessions.operator.accountId);
        expect(live.idempotencyKey).toBe(command.idempotencyKey);
        expect(Date.parse(live.requestedAt)).toBeGreaterThanOrEqual(Date.parse(issuance.answeredAt));
        expect(Date.parse(live.answeredAt)).toBeLessThan(Date.parse(input.validUntil));
      }
      const revocation = changes.find(request => (request.body as GrantInput).action === 'revoke'
        && (request.body as GrantInput).grantId === input.grantId)!;
      expect(revocation.answer.status).toBe(200);
      expect((JSON.parse(revocation.answer.body) as GrantAnswer).grant.active).toBe(false);
      if (index === 0) {
        const expired = episode[2]!;
        expect(Date.parse(expired.requestedAt)).toBeGreaterThan(Date.parse(input.validUntil));
        const newCommand = rules[rules.indexOf(expired) + 1]!;
        expect((newCommand.body as RuleInput).ref).not.toBe(command.ref);
        expect(Date.parse(newCommand.requestedAt)).toBeGreaterThan(Date.parse(input.validUntil));
        expect(newCommand.answer.status).toBe(403);
        expect(JSON.parse(newCommand.answer.body).code).toBe('governance_denied');
      } else if (index === 1) {
        expect(Date.parse(episode[2]!.requestedAt)).toBeGreaterThanOrEqual(Date.parse(revocation.answeredAt));
        const newCommand = rules[rules.indexOf(episode[2]!) + 1]!;
        expect((newCommand.body as RuleInput).ref).not.toBe(command.ref);
        expect(newCommand.answer.status).toBe(403);
        expect(JSON.parse(newCommand.answer.body).code).toBe('governance_denied');
      } else {
        expect(JSON.parse(publication.answer.body).ref).toBe(rule.ref);
      }
    }
    const foreign = rules.find(request => (request.body as RuleInput).scopeId === `governance:realm:${sessions.realm}`)!;
    expect(foreign.answer.status).toBe(403);
    expect(JSON.parse(foreign.answer.body).code).toBe('governance_denied');
    phase = 'closure-after-publisher-revocation';
    await effectClosure(sessions, rule);
  } finally {
    console.log('Publisher lifetime regression', JSON.stringify({ phase, realm: sessions.realm,
      setupSeconds: sessions.elapsedSeconds, elapsedSeconds: (performance.now() - started) / 1000, requests }));
    await sessions.close();
  }
}, 180_000);
