import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { statementFixture } from '../src/kernel/fake/catalogue-statements';
import { statementInput } from '../src/features/catalogue/statement-editor';
import { m } from '../src/paraglide/messages.js';

test('A contributor can find and correct an invalid date without reading an API pointer', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/subjects/correction' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { StatementEditor } = await import('../src/features/catalogue/statement-editor-view');
  // The original story fixture still owns the client, validation, citation and proposal receipt.
  const fixture = statementFixture('unknown-field-once');
  const initial = await fixture.editor.read();
  const original = statementInput(fixture.source);
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const o = { locale: 'en' as const };
  const input = (label: string) => {
    const fieldLabel = [...host.querySelectorAll('label')].find((node) => node.textContent === label)!;
    expect(fieldLabel).toBeDefined();
    const control = window.document.getElementById(fieldLabel.htmlFor)!;
    expect(control).not.toBeNull();
    return control;
  };
  const edit = async (label: string, value: string) => {
    const control = input(label);
    const values = control.tagName === 'SELECT' ? [value] : ['', ...value];
    for (const [index, next] of values.entries()) {
      await act(async () => {
        const prototype =
          control.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(
          control,
          control.tagName === 'SELECT' || index === 0 ? next : control.value + next,
        );
        control.dispatchEvent(new window.Event(control.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
      });
    }
    return control;
  };
  const submit = () =>
    act(async () => {
      host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await Bun.sleep(0);
    });
  try {
    await act(async () =>
      root.render(
        createElement(StatementEditor, {
          initial,
          locale: 'en',
          transport: fixture.editor,
          review: () => fixture.review,
        }),
      ),
    );
    await edit(m.correction_precision({}, o), '11');
    await edit(m.correction_year({}, o), '1946');
    await edit(m.correction_month({}, o), '2');
    const day = await edit(m.correction_day({}, o), '30');
    const dayId = day.id;
    expect(input(m.correction_year({}, o)).value).toBe('1946');
    expect(input(m.correction_month({}, o)).value).toBe('2');
    expect(day.value).toBe('30');
    await submit();
    expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    const summary = host.querySelector(`ul[aria-label="${m.correction_errors({}, o)}"]`)!;
    expect(summary.textContent).toContain(m.correction_date({}, o));
    expect(summary.textContent).toContain(m.correction_error_date({}, o));
    expect(summary.textContent).not.toContain('/statement/');
    expect(day.getAttribute('aria-invalid')).toBe('true');
    const description = window.document.getElementById(day.getAttribute('aria-describedby')!)!;
    expect(description.textContent).toContain(m.correction_error_date({}, o));
    const link = description.querySelector('a')!;
    const dateGroup = window.document.getElementById(link.getAttribute('href')!.slice(1))!;
    expect(dateGroup.getAttribute('role')).toBe('group');
    expect(dateGroup.contains(day)).toBe(true);
    expect(dateGroup.getAttribute('aria-invalid')).toBe('true');
    await act(async () => link.click());
    expect(window.document.activeElement).toBe(dateGroup);
    for (const label of [m.correction_year({}, o), m.correction_month({}, o), m.correction_precision({}, o)]) {
      expect(input(label).getAttribute('aria-describedby')).toBe(day.getAttribute('aria-describedby'));
      expect(input(label).getAttribute('aria-invalid')).toBe('true');
    }
    expect(new Set([...host.querySelectorAll('[id]')].map((node) => node.id)).size).toBe(
      host.querySelectorAll('[id]').length,
    );

    expect(await edit(m.correction_day({}, o), '28')).toBe(day);
    expect(day.id).toBe(dayId);
    expect(day.hasAttribute('aria-invalid')).toBe(false);
    await submit();
    // A server-only address has no fabricated control: the complete editor is the honest fallback.
    const fallback = host.querySelector(`ul[aria-label="${m.correction_errors({}, o)}"]`)!;
    expect(fallback.textContent).toContain(m.correction_error_unknown_field({}, o));
    expect(fallback.textContent).toContain(m.correction_error_uneditable({}, o));
    expect(fallback.textContent).not.toContain('serverOnly');
    const fallbackLink = fallback.querySelector('a')!;
    expect(fallbackLink.getAttribute('href')).toBe(`#${host.querySelector('form')!.id}`);
    await act(async () => fallbackLink.click());
    expect(window.document.activeElement).toBe(host.querySelector('form'));
    expect(day.getAttribute('aria-invalid')).toBeNull();
    expect(day.getAttribute('aria-describedby')).toBeNull();
    await submit();
    expect(host.textContent).toContain(m.correction_proposed({}, o));
    const proposals = fixture.calls.filter((call) => call.method === 'POST');
    expect(proposals).toHaveLength(2);
    const expected = {
      ...original,
      value: {
        type: 'value',
        content: {
          ...(original.value.type === 'value' ? (original.value.content as object) : {}),
          time: '+1946-02-28T00:00:00Z',
          precision: 11,
        },
      },
    };
    expect(proposals.map((call) => call.body)).toEqual([{ statement: expected }, { statement: expected }]);
    expect(
      fixture.candidate.statement.references.map((reference) => ({
        parts: reference.parts.map((part) => ({
          property: { id: part.property.id },
          value: part.value,
        })),
      })),
    ).toEqual(original.references);
    expect(fixture.candidate.statement.qualifiers).toEqual(fixture.source.qualifiers);
    expect(statementInput(fixture.source)).toEqual(original);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
