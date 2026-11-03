import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FilterDocument } from '@rezics/filter';
import { m } from '../src/paraglide/messages.js';
import recording from '../src/kernel/recorded/definitions-release.json';
import { ConditionEditor } from '../src/search/condition-editor';
import {
  CONDITION_POINTER,
  conditionAdmission,
  conditionMetadata,
  conditionTreeAdmission,
} from '../src/search/condition-editor-model';
import { editConditionTree } from '../src/search/condition-tree-edit';
import { searchLoaderDeps } from '../src/search/search-params';

const metadata = conditionMetadata(recording.release);
const book: FilterDocument = { type: { in: ['schema:Book'] } };
const realmId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const nextRealmId = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
const collectionId = '0192f3a0-6c1e-7b2a-9d4e-000000000003';
const realm = { realm: { id: realmId } } as FilterDocument;
const collection = { collection: { id: collectionId } } as FilterDocument;

test('Search admits only canonical request resource leaves while saved/public construction stays closed', () => {
  const tree = { and: [book, { or: [realm, { not: collection }] }] } as FilterDocument;
  const state = searchLoaderDeps({ q: 'books' });

  expect(conditionTreeAdmission(metadata)(tree)).toBe(false);
  expect(conditionTreeAdmission(metadata, { requestResources: true })(tree)).toBe(true);
  expect(conditionAdmission(metadata)(tree, state)).toEqual([]);
  expect(conditionAdmission(metadata)({ realm: { id: 'unfinished' } } as FilterDocument, state)).toEqual([
    { pointer: `${CONDITION_POINTER}/realm/id`, code: 'invalid_format' },
  ]);
  expect(conditionAdmission(metadata)({ collection: {} } as FilterDocument, state)).toEqual([
    { pointer: `${CONDITION_POINTER}/collection/id`, code: 'required' },
  ]);
});

test('tree editing nests, negates and removes resource leaves without dropping catalogue siblings', () => {
  const base = { and: [book, realm] } as FilterDocument;
  const nested = editConditionTree(base, ['and', 1], { type: 'operator', operator: 'or' });
  expect(nested.accepted).toBe(true);
  if (!nested.accepted) return;

  const withCollection = editConditionTree(nested.value, ['and', 1], { type: 'append', value: collection });
  expect(withCollection.accepted).toBe(true);
  if (!withCollection.accepted) return;
  const deniedLeaf = editConditionTree(withCollection.value, ['and', 1, 'or', 0], {
    type: 'operator',
    operator: 'not',
  });
  expect(deniedLeaf).toEqual({
    accepted: true,
    value: { and: [book, { or: [{ not: realm }, collection] }] },
  });
  if (!deniedLeaf.accepted) return;
  expect(editConditionTree(deniedLeaf.value, ['and', 1, 'or', 0], { type: 'remove' })).toEqual({
    accepted: true,
    value: { and: [book, { or: [collection] }] },
  });
});

test('the Search editor adds and edits canonical IDs in place and submits the authored tree unchanged', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/search' });
  const globals = {
    ...Object.fromEntries(
      ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Document', 'DocumentFragment', 'MutationObserver'].map(
        (key) => [key, Reflect.get(window, key)],
      ),
    ),
    window,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const { createRoot } = await import('react-dom/client');
  const testing = createRequire(require.resolve('storybook/test'));
  const { within } = await import(testing.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(testing.resolve('@testing-library/user-event'));
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const canvas = within(host);
  const user = userEvent.setup({ document: window.document, delay: null });
  const initial = { and: [book] } as FilterDocument;
  const labelOptions = { locale: 'en' as const };
  let authored: FilterDocument | undefined = initial;

  function Harness() {
    const [value, setValue] = useState<FilterDocument | undefined>(initial);
    return createElement(ConditionEditor, {
      value,
      metadata,
      locale: 'en',
      requestResources: { labels: [{ kind: 'realm', id: realmId, labels: { en: 'Civic Realm' } }] },
      onChange: (next) => {
        authored = next;
        setValue(next);
      },
    });
  }

  const click = (name: string) => act(async () => user.click(canvas.getByRole('button', { name })));
  const type = (input: HTMLInputElement, value: string) => act(async () => user.type(input, value));
  const resourceName = (kind: 'realm' | 'collection') =>
    `${kind === 'realm' ? m.space_realm_heading({}, labelOptions) : m.library_following_kind_collection({}, labelOptions)} · ${m.access_identity_resource_id({}, labelOptions)}`;

  try {
    await act(async () => root.render(createElement(Harness)));
    await click(`${m.condition_add({}, labelOptions)}: ${m.space_realm_heading({}, labelOptions)}`);
    const realmInput = canvas.getByRole('textbox', { name: resourceName('realm') }) as HTMLInputElement;
    expect(window.document.activeElement).toBe(realmInput);
    await type(realmInput, realmId);
    expect(canvas.getByText('Civic Realm')).toBeTruthy();

    await click(`${m.condition_add({}, labelOptions)}: ${m.library_following_kind_collection({}, labelOptions)}`);
    const collectionInput = canvas.getByRole('textbox', { name: resourceName('collection') }) as HTMLInputElement;
    await type(collectionInput, collectionId);
    await act(async () => user.clear(realmInput));
    await type(realmInput, nextRealmId);

    const expected = { and: [book, { realm: { id: nextRealmId } }, { collection: { id: collectionId } }] };
    expect(authored).toEqual(expected);
    expect(window.document.activeElement).toBe(realmInput);
    expect((host.querySelector('input[name="condition"]') as HTMLInputElement).value).toBe(JSON.stringify(expected));
    expect(canvas.getByRole('textbox', { name: resourceName('collection') })).toHaveProperty('value', collectionId);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    window.happyDOM.abort();
  }
});

test('native denial under NOT or true OR stays on the resource input and does not prune the authored condition', () => {
  const tree = { or: [book, { not: realm }] } as FilterDocument;
  const pointer = `${CONDITION_POINTER}/or/1/not/realm/id`;
  const options = { locale: 'en' as const };
  const html = renderToStaticMarkup(
    createElement(ConditionEditor, {
      value: tree,
      metadata,
      locale: 'en',
      issues: [{ pointer, code: 'unavailable' }],
      onChange() {},
    }),
  );

  expect(html).toContain(`data-error-pointer="${pointer}"`);
  expect(html).toContain(`data-condition-field-pointer="${pointer}"`);
  expect(html).toContain('aria-invalid="true"');
  expect(html).toContain(m.search_reader_condition_unsupported({ field: resourceName('realm') }, options));
  expect(html).toContain(`name="condition" value="${JSON.stringify(tree)}"`);

  function resourceName(kind: 'realm' | 'collection') {
    return `${kind === 'realm' ? m.space_realm_heading({}, options) : m.library_following_kind_collection({}, options)} · ${m.access_identity_resource_id({}, options)}`;
  }
});
