import { expect, test } from 'bun:test';
import { browserMainApi, BFF_PREFIX } from '../api/browser.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { createCommunityWithReadback, founderRealmReads, stepAfterCreation } from './create-form.tsx';
import { creationSample, creationStoryInputs, foundingPersonas, type CreationStoryState } from './creation-story-inputs.ts';
import { mapRealmCreation } from './realm-create-recorded-page.ts';

async function readForm(persona: typeof foundingPersonas[number], state: CreationStoryState = 'created') {
  const input = creationStoryInputs(persona, state);
  const transport = recordedFetch(input.record, persona, input.record.personas[persona].map(sample => ({
    label: sample.label, state: sample.status === 202 ? 'pending' : sample.status >= 400 ? 'error' : 'populated',
  })), { pathPrefix: BFF_PREFIX });
  try {
    const client = browserMainApi('https://recorded.invalid', { fetcher: transport.fetcher });
    const response = await createCommunityWithReadback(input.body, 'form-key', (body, key) =>
      client.v1.spaces.post(body, { headers: { 'idempotency-key': key } }));
    const step = await stepAfterCreation(response, input.body.handle!, input.body.actingSubject, founderRealmReads(client));
    return { input, mapped: mapRealmCreation({ response, step, name: input.body.name, handle: input.body.handle!,
      visibility: input.body.initialSettings!.visibility, actingSubject: input.body.actingSubject }) };
  } finally { transport.dispose(); }
}

for (const persona of foundingPersonas) {
  test(`${persona}: production form intent reads the unchanged receipt and preserves its author/Realm identity`, async () => {
    const { input, mapped } = await readForm(persona);
    expect(input.command.answer).toEqual(creationSample(persona, 'creation-receipt').answer);
    expect(mapped.kind).toBe('created');
    if (mapped.kind !== 'created') throw new Error('Expected a complete receipt');
    expect(mapped.identity.realm).toBe(input.answer.realm);
    expect(mapped.identity.owner).toBe(input.body.actingSubject);
    expect(mapped.identity.visibility).toBe('private');
    expect(input.missingRecordedStates).toContain(input.command);
  });
}

test('Pending creation retains the 202 operation and definitive refusals retain the exact problem sentence/code', async () => {
  expect((await readForm('stranger', 'pending')).mapped).toEqual({ kind: 'pending', operationId: 'creation-pending' });
  for (const [state, persona, label] of [
    ['quota', 'owner', 'creation-quota-denied'],
    ['conflict', 'stranger', 'creation-intent-conflict'],
    ['expired', 'visitor', 'creation-sign-in-required'],
  ] as const) {
    const { mapped } = await readForm(state === 'quota' ? 'owner' : 'stranger', state);
    const sample = creationSample(persona, label);
    const problem = sample.answer as { title: string; code: string };
    expect(mapped).toEqual({ kind: 'refusal', problem: { status: sample.status, title: problem.title, code: problem.code } });
  }
});

test('The owned handle is linked while moderation alone leaves the same handle taken', async () => {
  const owned = await readForm('stranger', 'owned');
  expect(owned.mapped).toEqual({ kind: 'owned', realm: owned.input.answer.realm });
  expect((await readForm('stranger', 'taken')).mapped).toEqual({ kind: 'taken' });
});
