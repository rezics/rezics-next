import { expect, test } from 'bun:test';
import { personaNames } from '../support/personas.ts';
import { SUGGESTION_COST } from '../../../services/main/src/modules/onboarding/contract.ts';
import { WORK_READ_COST } from '../../../services/main/src/modules/work/read-contract.ts';
import { useBoundedReadCorpus, sessions, privateRealm, corpus, measured, record, command, short } from '../support/bounded-read-corpus.ts';

useBoundedReadCorpus('zones');

test('D5-006: the ninth and tenth official Zones do not make six readers lose suggestions', async () => {
  const answers = [];
  for (const population of [8, 9, 10]) {
    if (population > 8) {
      const zone = corpus.zones[population - 1]!;
      await command(sessions.owner, 'PUT', `/v1/zones/${short(zone.zone)}/configuration`, {
        expectedHead: zone.revision, official: {}, actingSubject: sessions.owner.actingSubject });
    }
    for (const name of personaNames) {
      answers.push({ population, persona: name, result: await measured(sessions[name], 'GET',
        '/v1/onboarding/suggested-follows?languages=en') });
    }
  }
  record({ case: 'D5-006-zones', assertionReached: true,
    answers: answers.map(({ population, persona, result }) => ({ population, persona, status: result.status })) });
  for (const { result } of answers) {
    expect(result.status, JSON.stringify(result)).toBe(200);
    expect((result.body.items as unknown[]).length).toBeGreaterThan(0);
    expect((result.body.items as unknown[]).length).toBeLessThanOrEqual(SUGGESTION_COST.suggestions * 2);
    expect(result.graphCalls).toBeGreaterThan(0);
    expect(result.graphCalls).toBeLessThanOrEqual(WORK_READ_COST.graphCalls);
    expect(result.graphBytes).toBeLessThanOrEqual(WORK_READ_COST.graphBytes);
    expect(result.elapsedMs).toBeLessThan(WORK_READ_COST.deadlineMs);
    expect(JSON.stringify(result.body)).not.toContain(privateRealm.realm);
  }
}, 120_000);

