import { expect, test } from 'bun:test';
import { startMediaStack } from './media-support.ts';
import { acceptClassifiedWork, discloseConcept, shareClassifiedConcepts, type ClassifiedConcept } from './work-classification.ts';

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as T;
}

test('Work classification continuation survives a private draft and restarts for a new visible classification', async () => {
  const stack = await startMediaStack('work-classification-continuation');
  try {
    const editor = await stack.member('classification-editor');
    for (const [scope, action] of [['classification:define:global', 'classification.proposition.define'],
      ['classification:decide:global', 'statement.decide'], ['context:create:root', 'context.create'],
      [`statement:speak:${editor.actor}`, 'statement.record']]) await editor.grant(scope!, action!);
    const work = await stack.publicWork(editor.actor, ['en'], 'A classified Work');
    const terms: ClassifiedConcept[] = [];
    for (const value of ['First topic', 'Second topic', 'Third topic']) {
      const term = await json<ClassifiedConcept>(await editor.send('POST', '/v1/classification-vocabulary', {
        profile: 'classification-proposition-v2', scheme: null, labels: [{ language: 'en', value }],
        alternativeLabels: [], broader: [], narrower: [], actingSubject: editor.actor,
      }), 201);
      terms.push(term);
      await discloseConcept(stack.accessPool, editor.principal, editor.actor, term.concept);
    }
    const context = await shareClassifiedConcepts(editor.send, json, editor.actor, terms);
    for (const term of terms.slice(0, 2)) await acceptClassifiedWork(editor.send, json, editor.actor, work, term, context);
    const path = `/v1/works/${work.work.slice(-36)}/classifications?limit=1`;
    const first = await json<{ nextCursor: string }>(await stack.call('GET', path));
    expect(first.nextCursor).toBeString();
    await stack.privateWork(editor.actor, 'Invisible draft activity');
    expect((await stack.call('GET', `${path}&cursor=${encodeURIComponent(first.nextCursor)}`)).status).toBe(200);
    await acceptClassifiedWork(editor.send, json, editor.actor, work, terms[2]!, context);
    expect((await stack.call('GET', `${path}&cursor=${encodeURIComponent(first.nextCursor)}`)).status).toBe(409);
  } finally { await stack.stop(); }
}, 60_000);
