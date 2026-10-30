import { expect, test } from 'bun:test';
import { createElement, Fragment } from 'react';
import { renderToString } from 'react-dom/server';
import { collectEditorialEntries, contributionMenu } from '../src/features/catalogue/editorial-entry';
import {
  catalogueEntries,
  contributionHref,
  subjectContributionEntries,
} from '../src/features/catalogue/catalogue-entry';
import { CreateSubjectEntry } from '../src/features/catalogue/create-subject-entry';
import { AuthoredFieldEntry } from '../src/features/catalogue/authored-field-entry';
import { SubjectFactsEntry } from '../src/features/catalogue/subject-facts-entry';
import { SubjectTermsEntry } from '../src/features/catalogue/subject-terms-entry';
import { SubjectChangesLink } from '../src/features/catalogue/subject-changes-link';
import { RecipeEditorEntry } from '../src/features/catalogue/recipe-editor-entry';
import { PublicationEditorEntry } from '../src/features/catalogue/publication-editor-entry';
import { SubjectFrame } from '../src/features/pages/subject-frame';
import { subjectHref } from '../src/subject/subject-href';
import { viewTabLabels } from '../src/features/pages/route-support';
import { catalogueSourcesFixture, sourceDefinitions } from '../src/kernel/fake/catalogue-sources';
import { readSubjectSources } from '../src/features/catalogue/subject-sources';
import { SubjectSourcesPage } from '../src/features/catalogue/subject-sources-page';

const address = { id: '00000000-0000-4000-8000-00000000c001', label: 'A / multilingual title', locale: 'en' };
const context = '00000000-0000-4000-8000-00000000c002';
const base = subjectHref(address, address.locale).href;
const children = [
  createElement(PublicationEditorEntry, { work: address.id, locale: address.locale }),
  createElement(CreateSubjectEntry, { locale: address.locale }),
  createElement(AuthoredFieldEntry, { ...address, title: address.label }),
  createElement(SubjectFactsEntry, address),
  createElement(RecipeEditorEntry, address),
  createElement(SubjectTermsEntry, address),
  createElement(SubjectChangesLink, { ...address, title: address.label }),
];

test('Make the subject contribution entry coherent and discoverable through existing current APIs with honest incomplete or denied states', () => {
  const result = collectEditorialEntries(createElement(Fragment, null, children));
  expect(result.retained).toEqual([]);
  expect(result.entries.map(({ href }) => href)).toEqual([
    `/en/catalogue/publication?work=${address.id}`,
    '/en/catalogue/new',
    `${base}/authored`,
    `${base}/edit`,
    `${base}/recipe`,
    `${base}/terms`,
    `${base}/changes`,
  ]);
  expect(result.entries.map(({ group }) => group)).toEqual([
    'create',
    'create',
    'edit',
    'edit',
    'edit',
    'edit',
    'read',
  ]);
  for (let index = 0; index < children.length; index++)
    expect(renderToString(children[index]!)).toContain(`href="${result.entries[index]!.href}"`);
});

test('caller availability and unrelated native actions survive grouping without inferred publication or recipe links', () => {
  const nativeAction = createElement('button', { type: 'button' }, 'Native action');
  const result = collectEditorialEntries([false, children[1], children[3], nativeAction]);
  expect(result.retained).toEqual([nativeAction]);
  expect(result.entries.map(({ href }) => href)).toEqual(['/en/catalogue/new', `${base}/edit`]);
  expect(catalogueEntries.recipe({ locale: 'en' }).href).toBe('/en/catalogue/recipe');
});

test('review preserves the actual selected Context; relations preserve Realm; Sources and Changes remain ordinary readers', () => {
  const extra = subjectContributionEntries({ ...address, context, realm: 'example-realm' });
  expect(extra.map(({ href }) => href)).toEqual([
    `${base}/relation-edit?realm=example-realm`,
    `${base}/context-review?context=${context}`,
    `${base}/sources`,
  ]);
  const menu = contributionMenu([...collectEditorialEntries(children).entries, ...extra], 'en', false);
  expect(menu.map((group) => group.type === 'submenu' && group.entries.length)).toEqual([2, 5, 1, 2]);
  expect(subjectContributionEntries(address).some((entry) => entry.group === 'review')).toBe(false);
});

test('signed-out actions return to the exact selected destination while read-only explanations remain directly readable', () => {
  for (const locale of ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es']) {
    const links = [
      ...collectEditorialEntries(children).entries,
      ...subjectContributionEntries({ ...address, locale, context, realm: 'a realm' }),
    ];
    for (const entry of links) {
      const href = contributionHref(entry, true);
      if (entry.group === 'read') expect(href).toBe(entry.href);
      else expect(new URL(href, 'https://rezics.test').searchParams.get('return_to')).toBe(entry.href);
    }
    const menu = contributionMenu(links, locale, true);
    expect(menu.every((group) => group.type === 'submenu' && group.label.trim())).toBe(true);
  }
});

test('compact subject actions expose one Contribute control and preserve existing Work title typography', () => {
  const html = renderToString(
    createElement(SubjectFrame, {
      frame: { ...address, type: 'schema:Book', title: { text: address.label, lang: 'ja' }, summary: null, context },
      locale: 'en',
      unlabelled: 'Unnamed',
      view: 'editions',
      tabs: [],
      tabLabels: viewTabLabels(),
    }),
  );
  const actions = html.match(/<div data-slot="actions">(.*?)<\/div>/s)?.[1] ?? '';
  expect(actions.match(/<button/g)).toHaveLength(1);
  expect(actions).toContain('Contribute');
  expect(actions).not.toContain('<a');
  expect(html).toContain('font-serif');
  expect(html).toContain('lang="ja"');
});

test('read-only destinations retain actual denied and unavailable reader outcomes without a fabricated empty success', async () => {
  for (const kind of ['denied', 'unavailable'] as const) {
    const fixture = catalogueSourcesFixture(kind);
    const entry = subjectContributionEntries({ ...address, id: fixture.id }).find((item) => item.group === 'read')!;
    expect(contributionHref(entry, true)).toContain('/sources');
    const result = await readSubjectSources(fixture.client, fixture.id, 'en', sourceDefinitions);
    expect(result).toEqual({ kind });
    const html = renderToString(createElement(SubjectSourcesPage, { result, locale: 'en', onRetry: () => {} }));
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('Reviewed bibliography');
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]!.authorization).toBeNull();
  }
});
