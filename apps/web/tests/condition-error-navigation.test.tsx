import { createRequire } from 'node:module';
import { expect, test } from 'bun:test';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import type { FilterDocument } from '@rezics/filter';
import recording from '../src/kernel/recorded/definitions-release.json';
import { ConditionEditor } from '../src/search/condition-editor';
import { CONDITION_POINTER, conditionMetadata } from '../src/search/condition-editor-model';
import { findConditionErrorTarget } from '../src/search/condition-error-target';
import { m } from '../src/paraglide/messages.js';

test('summary navigation focuses the scoped qualifier field, then its group when hidden, without editing the draft', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/search' });
  const original = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  let root: Root | undefined;
  try {
    const { createRoot } = await import('react-dom/client');
    const host = window.document.createElement('main');
    window.document.body.append(host);
    root = createRoot(host as unknown as HTMLElement);
    const metadata = conditionMetadata(recording.release);
    metadata.properties['schema:author'] = {
      ...metadata.properties['schema:author']!,
      qualifiers: ['schema:isPartOf'],
    };
    const tree: FilterDocument = {
      statement: {
        property: 'schema:author',
        in: ['author'],
        qualifiers: [{ property: 'schema:isPartOf', in: ['book'] }],
      },
    };
    const before = JSON.stringify(tree);
    const pointer = `${CONDITION_POINTER}/statement/qualifiers/0/in/0`;
    const issues = [
      { pointer, code: 'unsupported' },
      { pointer: '/text', code: 'invalid' },
    ];
    const changes = [0, 0, 0];
    const editor = (index: number, value: FilterDocument | undefined, errors = issues) =>
      createElement(ConditionEditor, {
        value,
        metadata,
        locale: 'en',
        issues: errors,
        values: {
          'schema:author': [{ value: 'author', labels: { en: 'Author' } }],
          'schema:isPartOf': [{ value: 'book', labels: { en: 'Book' } }],
        },
        onChange() {
          changes[index] = changes[index]! + 1;
        },
      });
    const emptyPointer = `${CONDITION_POINTER}/and/0/statement/property`;
    await act(async () => {
      root!.render(
        createElement(
          'div',
          null,
          editor(0, tree),
          editor(1, tree),
          editor(2, undefined, [{ pointer: emptyPointer, code: 'required' }]),
        ),
      );
    });

    const editors = host.querySelectorAll<HTMLElement>('[data-condition-editor]');
    const first = editors[0]!;
    const secondField = editors[1]!.querySelector<HTMLElement>(`[data-condition-field-pointer="${pointer}"] input`);
    const field = first.querySelector<HTMLElement>(`[data-condition-field-pointer="${pointer}"] input`);
    const action = first.querySelector<HTMLButtonElement>(`[data-error-pointer="${pointer}"] button`);
    const textIssue = first.querySelector(`[data-error-pointer="/text"]`);
    expect(field).not.toBeNull();
    expect(action?.textContent).toBe(m.condition_error_jump_target());
    expect(textIssue?.querySelector('button')).toBeNull();
    expect(textIssue?.textContent).toContain(m.condition_text_error());

    await act(async () => action!.click());
    expect(window.document.activeElement).toBe(field);
    expect(window.document.activeElement).not.toBe(secondField);

    field!.setAttribute('hidden', '');
    await act(async () => action!.click());
    expect(window.document.activeElement).toBe(
      first.querySelector(`[data-condition-pointer="${CONDITION_POINTER}/statement/qualifiers/0"]`),
    );

    const emptyEditor = editors[2]!;
    await act(async () => emptyEditor.querySelector('button')!.click());
    expect(window.document.activeElement).toBe(emptyEditor.querySelector('[data-condition-errors]'));
    expect(changes).toEqual([0, 0, 0]);
    expect(JSON.stringify(tree)).toBe(before);

    // Reopen an inverse occurrence, review replacement, cancel, then deliberately repair a retained range.
    let current: FilterDocument = { statement: { ...tree.statement, inverse: true } };
    const renderCorrection = () =>
      root!.render(
        createElement(ConditionEditor, {
          value: current,
          metadata,
          locale: 'en',
          values: {
            'schema:author': [{ value: 'author', labels: { en: 'Selected author' } }],
            'schema:isPartOf': [{ value: 'book', labels: { en: 'Selected book' } }],
          },
          onChange(next) {
            current = next!;
            renderCorrection();
          },
        }),
      );
    const select = async (pointer: string, value: string) => {
      const control = host.querySelector<HTMLSelectElement>(
        `[data-condition-field-pointer="${CONDITION_POINTER}/statement/${pointer}"] input`,
      )!;
      await act(async () => {
        control.value = value;
        control.dispatchEvent(new window.Event('change', { bubbles: true }));
      });
    };
    const press = async (label: string) =>
      act(async () => {
        [...host.querySelectorAll('button')].find((button) => button.textContent === label)!.click();
      });
    await act(async () => renderCorrection());
    const originalInverse = current;
    await select('property', 'schema:wordCount');
    expect(host.querySelector('dialog')?.textContent).toContain(m.condition_property_change_direction_reset());
    expect(host.querySelector('[data-property-change-version="original"]')?.textContent).toContain('Selected author');
    await press(m.condition_property_change_cancel());
    expect(current).toBe(originalInverse);
    await select('property', 'schema:wordCount');
    await press(m.condition_property_change_confirm());
    expect(current).toMatchObject({ statement: { property: 'schema:wordCount', range: {} } });
    expect('inverse' in (current as typeof tree).statement).toBe(false);
    current = {
      statement: { property: 'schema:wordCount', range: { gte: 7 }, inverse: true },
    } as unknown as FilterDocument;
    await act(async () => renderCorrection());
    await select('inverse', 'direct');
    expect(current).toEqual({ statement: { property: 'schema:wordCount', range: { gte: 7 } } });
    current = originalInverse;
    await act(async () => renderCorrection());
    await select('property', 'schema:wordCount');
    current = { statement: { ...tree.statement, inverse: true, in: ['different'] } };
    await act(async () => renderCorrection());
    expect(host.querySelector('dialog')).toBeNull();

    const synthetic = window.document.createElement('div');
    synthetic.setAttribute('data-condition-editor', '');
    const summary = window.document.createElement('div');
    summary.dataset.conditionErrors = '';
    summary.tabIndex = -1;
    synthetic.append(summary);
    const group = window.document.createElement('fieldset');
    group.dataset.conditionPointer = `${CONDITION_POINTER}/statement~1name~0part`;
    group.tabIndex = -1;
    synthetic.append(group);
    const fieldWrapper = window.document.createElement('div');
    fieldWrapper.dataset.conditionFieldPointer = `${CONDITION_POINTER}/statement~1name~0part/property`;
    const control = window.document.createElement('input');
    fieldWrapper.append(control);
    group.append(fieldWrapper);
    expect(findConditionErrorTarget(synthetic, fieldWrapper.dataset.conditionFieldPointer!)?.element).toBe(control);
    control.hidden = true;
    expect(findConditionErrorTarget(synthetic, `${fieldWrapper.dataset.conditionFieldPointer}/removed`)?.element).toBe(
      group,
    );

    const sibling = window.document.createElement('fieldset');
    sibling.dataset.conditionPointer = `${CONDITION_POINTER}/and/1`;
    sibling.tabIndex = -1;
    synthetic.append(sibling);
    expect(findConditionErrorTarget(synthetic, `${CONDITION_POINTER}/and/10/statement/property`)?.kind).toBe('summary');
  } finally {
    if (root) await act(async () => root!.unmount());
    for (const [key] of Object.entries(globals)) {
      const descriptor = original.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});
