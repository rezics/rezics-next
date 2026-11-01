import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import {
  PROFILE_FORMAT,
  VIEWS,
  platformRegistry,
  resolveView,
  validateProfile,
  type CompositionDocument,
  type PresentationProfile,
  type View,
} from '@rezics/composition';
import {
  overviewOf,
  profileTemplates,
  templateViewNames,
  viewOf,
  viewPointer,
  withTemplate,
  withView,
  type Template,
} from '../src/features/pages/curate';
import {
  discardPresentationDraft,
  editView,
  hasDraftChanges,
  presentationDraft,
  selectTemplate,
  selectionKey,
} from '../src/features/pages/curate-view-editor-state';
import { editorConfig, fromComposition, toComposition } from '../src/features/pages/editor-config';

// These render-only previews do not use the request environment or load page data.
mock.module('cloudflare:workers', () => ({ env: {} }));
const { PageLocaleProvider } = await import('../src/features/pages/data');
const { layoutComponents } = await import('../src/features/pages/layout');

const document = (name: string): CompositionDocument => ({
  root: { props: { appearance: { density: 'compact', surface: 'cards' } } },
  content: [
    {
      type: 'Heading',
      props: { id: 'title', level: 2, text: { en: name, ja: `日本語 ${name}`, de: `Deutsch ${name}` } },
    },
  ],
});
const profile = (): PresentationProfile => ({
  format: PROFILE_FORMAT,
  generic: {
    views: Object.fromEntries(VIEWS.map((view) => [view, document(`generic ${view}`)])) as {
      overview: CompositionDocument;
    },
  },
  bases: [{ base: 'schema:CreativeWork', views: { overview: document('work'), credits: document('credits') } }],
  types: [
    {
      type: 'schema:Book',
      views: { overview: document('book'), editions: document('editions'), details: document('details') },
    },
  ],
  routes: [{ route: '/', document: document('home') }],
});
const snapshot = () => ({
  ok: true as const,
  reader: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10',
  profile: profile(),
  head: 7,
  digest: `sha256:${'a'.repeat(64)}`,
});
const generic: Template = { scope: 'generic', key: null };
const book: Template = { scope: 'type', key: 'schema:Book' };

function edited(source: CompositionDocument, text: string) {
  const data = fromComposition(source);
  data.content[0]!.props.text = { ...(data.content[0]!.props.text as object), en: text, fr: '' };
  return data;
}

test('Complete per-view Puck presentation template authoring', () => {
  const saved = snapshot();
  const before = structuredClone(saved);
  let draft = presentationDraft(saved);
  // Every existing view in each scope is independently editable through the shared Puck data converter.
  for (const template of profileTemplates(saved.profile)) {
    draft = selectTemplate(draft, template);
    for (const view of templateViewNames(saved.profile, template)) {
      const selection = { template, view };
      const data = edited(viewOf(draft.profile, template, view)!, `${template.scope} ${view} edited`);
      draft = editView(draft, selection, data);
      expect(draft.editors[selectionKey(selection)]).toEqual(data);
    }
  }
  draft = selectTemplate(draft, book);
  expect(hasDraftChanges(draft)).toBe(true);
  expect(validateProfile(platformRegistry, draft.profile)).toEqual([]);
  for (const template of profileTemplates(saved.profile)) {
    for (const view of templateViewNames(saved.profile, template)) {
      const selection = { template, view };
      const data = draft.editors[selectionKey(selection)]!;
      expect(toComposition(data)).toEqual(viewOf(draft.profile, template, view));
      expect(data.content[0]!.props.text).toHaveProperty('fr', '');
      expect(viewOf(draft.profile, template, view)!.content[0]!.props.text).toEqual({
        ...(viewOf(saved.profile, template, view)!.content[0]!.props.text as object),
        en: `${template.scope} ${view} edited`,
      });
    }
  }
  expect(saved).toEqual(before);
  const discarded = discardPresentationDraft(draft);
  expect(discarded.profile).toEqual(saved.profile);
  expect(discarded.selection).toEqual(draft.selection);
  expect(discarded.editors).toEqual({});
  expect(hasDraftChanges(discarded)).toBe(false);
});

test('native route, type, nearest structural base and generic resolution stays independent per view', () => {
  const initial = profile();
  const target = { route: '/', type: 'schema:Book', bases: ['schema:CreativeWork'] };
  const next = withView(initial, book, 'details', document('changed details'));
  expect(resolveView(next, target, 'overview')).toEqual({
    scope: 'route',
    key: '/',
    document: initial.routes[0]!.document,
  });
  expect(resolveView(next, target, 'editions')?.document).toEqual(viewOf(initial, book, 'editions'));
  expect(resolveView(next, target, 'credits')?.scope).toBe('base');
  expect(resolveView(next, target, 'relations')?.scope).toBe('generic');
  expect(resolveView(next, target, 'details')?.document).toEqual(document('changed details'));
  expect(templateViewNames(next, book)).toEqual(['overview', 'editions', 'details']);
  expect(viewOf(next, book, 'relations')).toBeUndefined();
  expect(next.bases).toEqual(initial.bases);
  expect(next.generic).toEqual(initial.generic);
  expect(next.routes).toEqual(initial.routes);
  expect(overviewOf(next, book)).toEqual(overviewOf(initial, book));
  expect(() => withView(next, { scope: 'route', key: '/' }, 'details', document('invalid route'))).toThrow();
});

test('overview shorthands and unselected views survive adding and editing a template', () => {
  let initial = profile();
  initial = { ...initial, generic: document('generic') };
  const next = withTemplate(initial, { scope: 'type', key: 'schema:Movie' }, document('movie'));
  expect(next.types.map((entry) => entry.type)).toEqual(['schema:Book', 'schema:Movie']);
  expect(next.types[0]).toEqual(initial.types[0]);
  expect(next.types[1]).toEqual({ type: 'schema:Movie', document: document('movie') });
  expect(withView(next, generic, 'overview', document('edited generic')).generic).toEqual(document('edited generic'));
  expect(withView(next, generic, 'relations', document('relations')).generic).toEqual({
    views: { overview: document('generic'), relations: document('relations') },
  });
});

test('invalid drafts survive selection and native pointers identify the right template and view', () => {
  let draft = presentationDraft(snapshot());
  const selection = { template: book, view: 'details' as View };
  const invalid = edited(viewOf(draft.profile, book, 'details')!, '<script>execute()</script>');
  draft = editView(draft, selection, invalid);
  draft = selectTemplate(draft, generic);
  draft = selectTemplate(draft, book);
  expect(draft.editors[selectionKey(selection)]).toEqual(invalid);
  expect(viewPointer(draft.profile, book, 'details')).toBe('/types/0/views/details');
  expect(viewPointer(draft.profile, { scope: 'route', key: '/' }, 'overview')).toBe('/routes/0/document');
  expect(validateProfile(platformRegistry, draft.profile)).toContainEqual({
    pointer: '/types/0/views/details/content/0/props/text/en',
    code: 'unsafe',
  });
  expect(validateProfile(platformRegistry, discardPresentationDraft(draft).profile)).toEqual([]);
});

test('the same registry refuses executable props, open appearance tokens, slots and whole-view read budgets', () => {
  const initial = profile();
  const bad = document('invalid');
  bad.root.props = { appearance: { density: 'arbitrary-css' } };
  expect(validateProfile(platformRegistry, withView(initial, book, 'details', bad)).length).toBeGreaterThan(0);
  const nodes = Array.from({ length: 17 }, (_, index) => ({
    type: 'SubjectList',
    props: { id: `list${index}`, property: `schema:relation${index}`, title: { en: 'Related' }, limit: 1 },
  }));
  const budget = { root: { props: {} }, content: nodes };
  expect(validateProfile(platformRegistry, withView(initial, book, 'details', budget))).toContainEqual({
    pointer: '/types/0/views/details/content',
    code: 'limit',
  });
  const cost = {
    ...budget,
    content: nodes.slice(0, 6).map((node) => ({ ...node, props: { ...node.props, limit: 24 } })),
  };
  expect(validateProfile(platformRegistry, withView(initial, book, 'details', cost))).toContainEqual({
    pointer: '/types/0/views/details/content',
    code: 'limit',
  });
  const slot = {
    root: { props: {} },
    content: [{ type: 'Slot', props: { id: 'slot', name: 'arbitrary', content: [] } }],
  };
  expect(validateProfile(platformRegistry, withView(initial, book, 'details', slot)).length).toBeGreaterThan(0);
  const heading = editorConfig(platformRegistry, { locale: 'ja' }).components.Heading!;
  expect(heading.fields?.level).toMatchObject({
    options: [1, 2, 3, 4].map((value) => ({ value, label: String(value) })),
  });
});

test('the editor catalogue supplies the same authoring controls in all eight locales', async () => {
  const locales = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'es', 'fr'];
  let keys: string[] | undefined;
  for (const locale of locales) {
    const messages = await Bun.file(new URL(`../messages/${locale}.json`, import.meta.url)).json();
    const current = Object.keys(messages)
      .filter((key) => key.startsWith('curation_'))
      .sort();
    expect(current.length).toBeGreaterThan(50);
    if (keys) expect(current).toEqual(keys);
    keys = current;
  }
});

test('shared heading previews use actual language data and interface typography at all four levels', () => {
  for (const level of [1, 2, 3, 4]) {
    const html = renderToString(
      createElement(PageLocaleProvider, {
        locale: 'ja',
        children: createElement(layoutComponents.Heading, {
          id: `heading${level}`,
          level,
          text: { en: 'English title', ja: '日本語の見出し' },
        }),
      }),
    );
    expect(html).toContain(`<h${level}`);
    expect(html).toContain('日本語の見出し');
    expect(html).not.toContain('English title');
    expect(html).not.toContain('font-serif');
  }
});
