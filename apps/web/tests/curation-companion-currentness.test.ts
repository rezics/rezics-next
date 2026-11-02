import { expect, test } from 'bun:test';
import { PROFILE_FORMAT, type CompositionDocument, type PresentationProfile } from '@rezics/composition';
import { addCompanionView, resetCompanionView, viewOf, withView, type Template } from '../src/features/pages/curate';
import {
  admitCompanionAdd,
  admitCompanionReset,
  companionResetIntent,
  type CompanionAddChoice,
} from '../src/features/pages/curation-companion-state';

const document = (text: string): CompositionDocument => ({
  root: { props: {} },
  content: [{ type: 'Heading', props: { id: 'heading', level: 2, text: { en: text } } }],
});
const template: Template = { scope: 'type', key: 'schema:Book' };
const overview = document('book');
const details = document('details');
const initial: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: { views: { overview: document('generic'), relations: document('generic relations') } },
  bases: [{ base: 'schema:Work', views: { overview: document('work'), relations: document('base relations') } }],
  types: [{ type: 'schema:Book', views: { overview, details } }],
  routes: [{ route: '/', document: document('home') }],
};
const relationsAdd: CompanionAddChoice = { view: 'relations', source: 'overview' };

test('changing the edited profile cannot add a present view or confirm a replaced override', () => {
  expect(admitCompanionAdd(relationsAdd, initial, template)).toBe(relationsAdd);
  const sibling = withView(initial, template, 'details', document('edited details'));
  expect(admitCompanionAdd(relationsAdd, sibling, template)).toBe(relationsAdd);
  expect(admitCompanionAdd(relationsAdd, { ...sibling }, template)).toBe(relationsAdd);

  const present = addCompanionView(initial, template, 'relations', 'overview');
  expect(admitCompanionAdd(relationsAdd, present, template)).toEqual({ view: '', source: 'overview' });
  expect(() => addCompanionView(present, template, 'relations', 'overview')).toThrow(TypeError);

  const missingOverview = {
    ...initial,
    types: [{ type: 'schema:Book', views: { details } }],
  };
  expect(admitCompanionAdd(relationsAdd, missingOverview, template)).toEqual({ view: 'relations', source: '' });
  expect(admitCompanionAdd({ view: 'relations', source: 'empty' }, missingOverview, template).source).toBe('empty');

  const added = addCompanionView(initial, template, 'relations', 'empty');
  expect(viewOf(added, template, 'relations')).toEqual({ root: { props: {} }, content: [] });
  expect(viewOf(added, template, 'relations')).not.toBe(viewOf(added, template, 'overview'));
  expect(viewOf(added, template, 'details')).toBe(details);

  const intent = companionResetIntent(added, template, 'relations');
  expect(admitCompanionReset(intent, added, template)).toBe(intent);
  expect(admitCompanionReset(intent, { ...added }, template)).toBe(intent);
  const siblingReset = withView(added, template, 'details', document('sibling edit'));
  expect(admitCompanionReset(intent, siblingReset, template)).toBe(intent);
  expect(viewOf(siblingReset, template, 'relations')).toBe(intent?.document);

  const replaced = withView(added, template, 'relations', document('replacement'));
  expect(admitCompanionReset(intent, replaced, template)).toBeNull();
  const removed = resetCompanionView(added, template, 'relations');
  expect(admitCompanionReset(intent, removed, template)).toBeNull();
  expect(viewOf(removed, template, 'overview')).toBe(overview);
  expect(viewOf(removed, template, 'details')).toBe(details);
  expect(admitCompanionReset(null, added, template)).toBeNull();
  expect(viewOf(added, template, 'relations')).toBe(intent?.document);
});
