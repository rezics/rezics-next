import { expect, test } from 'bun:test';
import { personaNames } from '../support/personas.ts';
import { GLOBAL_AGGREGATE_BUDGET, GLOBAL_AGGREGATE_PROFILE } from '../../../services/main/src/modules/rating/global-aggregate.ts';
import { useBoundedReadCorpus, sessions, reserve, corpus, measured, record, command } from '../support/bounded-read-corpus.ts';

useBoundedReadCorpus('ratings');

test('D5-006: 100, 101 and 102 independently receipted ratings remain readable without revealing voters', async () => {
  const answers = [];
  for (const population of [100, 101, 102]) {
    if (population > 100) {
      const person = population === 101 ? reserve.owner : reserve.member;
      await command(person, 'POST', '/v1/global-rating-observations', { profile: 'global-rating-standing-observation-v1',
        context: corpus.context, work: corpus.book.work, mainVersion: corpus.book.mainVersion, value: 5,
        expectedRevisionHead: null, actingSubject: person.actingSubject });
    }
    for (const name of personaNames) answers.push({ population, persona: name,
      result: await measured(sessions[name], 'POST', '/v1/global-rating-aggregates', {
        profile: GLOBAL_AGGREGATE_PROFILE, context: corpus.context,
        work: corpus.book.work, mainVersion: corpus.book.mainVersion }) });
  }
  record({ case: 'D5-006-ratings', assertionReached: true,
    answers: answers.map(({ population, persona, result }) => ({ population, persona, status: result.status })) });
  for (const { population, result } of answers) {
    expect(result.status, JSON.stringify(result)).toBe(200);
    expect(result.body).toMatchObject({ complete: true, count: population, withdrawnCount: 0, mean: 5,
      population: 'global-account-principal' });
    expect(result.graphCalls).toBe(GLOBAL_AGGREGATE_BUDGET.graphCalls);
    expect(result.graphBytes).toBeLessThanOrEqual(GLOBAL_AGGREGATE_BUDGET.graphBytes);
    expect(result.elapsedMs).toBeLessThan(GLOBAL_AGGREGATE_BUDGET.deadlineMs);
    expect(JSON.stringify(result.body)).not.toContain('principalId');
    expect(JSON.stringify(result.body)).not.toContain('rating-slot:');
  }
}, 120_000);

