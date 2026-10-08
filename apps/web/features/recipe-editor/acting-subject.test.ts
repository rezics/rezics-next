import { expect, test } from 'bun:test';
import { uuidToSid } from '@rezics/model/address';
import { agents, ids } from '../studio/fixtures.ts';
import { createdWorkPath, editingHref, studioSegment } from '../studio/agent.ts';
import { recipeActor } from './acting.ts';
import { recipeEditHref } from './route.ts';

const session = agents[0]!;
const studio = agents[1]!;
const segmentOf = (agent: { iri: string; handle: string | null }) =>
  `@${agent.handle ?? uuidToSid(agent.iri.slice(-36))}`;

test('session A and Studio B: creating and reopening a recipe edits it as B', () => {
  const created = createdWorkPath(studio, ids.recipe, 'recipe', 'en');
  const write = editingHref(studio, ids.recipe, 'recipe', { language: 'en' });
  const again = editingHref(studio, ids.recipe, 'recipe', { language: 'ja', text: { id: ids.texts.recipe, revision: null } });
  for (const href of [created, write, again]) {
    const segment = new URL(href, 'https://rezics.com').searchParams.get('agent');
    expect(segment).toBe(segmentOf(studio));
    expect(recipeActor(segment, agents, session.iri)).toEqual({ kind: 'named', actingSubject: studio.iri });
  }
  expect(studioSegment(studio)).toBe(segmentOf(studio));
});

test('a link naming an Agent this account cannot act for is sent to Main, not replaced by the session', () => {
  const foreign = '00000000-0000-4000-8000-000000000099';
  const actor = recipeActor(`@${uuidToSid(foreign)}`, agents, session.iri);
  expect(actor).toEqual({ kind: 'named', actingSubject: `https://rezics.com/id/${foreign}` });
  expect(actor.kind === 'named' && actor.actingSubject).not.toBe(session.iri);
});

test('a recipe link without a Studio Agent still edits as the session Agent', () => {
  expect(recipeActor(null, agents, session.iri)).toEqual({ kind: 'session', actingSubject: session.iri });
  expect(recipeEditHref(ids.recipe)).not.toContain('agent=');
});
