import { expect, test } from 'bun:test';
import { personaNames } from '../support/personas.ts';
import { GLOBAL_AGGREGATE_BUDGET, GLOBAL_AGGREGATE_PROFILE } from '../../../services/main/src/modules/rating/global-aggregate.ts';
import { useBoundedReadCorpus, sessions, reserve, corpus, measured, record, command } from '../support/bounded-read-corpus.ts';

useBoundedReadCorpus('ratings');

// Advance the same retained population once and share its real API observations,
// so every persona gets an independent assertion without rebuilding 100 voters.
let observations: ReturnType<typeof sample> | undefined;
async function sample() {
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
  return answers;
}

for (const name of personaNames) test(`D5-006 ${name}: 100, 101 and 102 ratings remain readable without revealing voters`, async () => {
  const answers = (await (observations ??= sample())).filter(answer => answer.persona === name);
  record({ case: 'D5-006-ratings', persona: name, assertionReached: true,
    answers: answers.map(({ population, result }) => ({ population, status: result.status })) });
  for (const { population, result } of answers) {
    expect(result.status, JSON.stringify(result)).toBe(200);
    expect(result.body).toMatchObject({ complete: true, count: population, withdrawnCount: 0, mean: 5,
      population, populationPolicy: 'global-account-principal' });
    expect(result.graphCalls).toBe(GLOBAL_AGGREGATE_BUDGET.graphCalls);
    expect(result.graphBytes).toBeLessThanOrEqual(GLOBAL_AGGREGATE_BUDGET.graphBytes);
    expect(result.elapsedMs).toBeLessThan(GLOBAL_AGGREGATE_BUDGET.deadlineMs);
    expect(JSON.stringify(result.body)).not.toContain('principalId');
    expect(JSON.stringify(result.body)).not.toContain('rating-slot:');
  }
}, 120_000);

