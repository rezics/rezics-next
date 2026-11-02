// UNRUN: actual-view composition witnesses. Native, browser, geometry, full/growth
// and private SSR acceptance remain with integration; static markup is not SSR authority proof.
import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { fromPlainText } from '@rezics/document';
import type { AuthoredRead } from '../src/features/catalogue/authored-field';

async function mountedFamily() {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue/authored', width: 390, height: 844 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    Element: window.Element,
    Node: window.Node,
    Text: window.Text,
    NodeFilter: window.NodeFilter,
    DocumentFragment: window.DocumentFragment,
    DOMParser: window.DOMParser,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    Range: window.Range,
    DOMRect: window.DOMRect,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const storybook = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { within } = await import(Bun.resolveSync('@testing-library/dom', storybook));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', storybook));
  const { AuthoredField } = await import('../src/features/catalogue/authored-field-view');
  const { authoredFixture, authoredProperty } = await import('../src/kernel/fake/authored-field');
  const { m } = await import('../src/paraglide/messages.js');
  const host = window.document.createElement('div') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const user = userEvent.setup({ document: window.document });
  const render = async (children: React.ReactNode) => act(async () => root.render(children));
  const click = async (scope: HTMLElement, name: string) =>
    act(async () => user.click(within(scope).getByRole('button', { name })));
  const input = (scope: HTMLElement, name: string) => within(scope).getByRole('textbox', { name }) as HTMLInputElement;
  const replace = async (control: HTMLElement, value: string) =>
    act(async () => {
      await user.clear(control);
      if (value) await user.type(control, value);
    });
  const editor = async (scope: HTMLElement, text: string) =>
    act(async () => {
      const editor = scope.querySelector('[contenteditable="true"]')!;
      editor.innerHTML = `<p>${text}</p>`;
      editor.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      await Bun.sleep(180);
      editor.dispatchEvent(new window.FocusEvent('blur'));
    });
  const compose = async (scope: HTMLElement, text = 'A separate original draft.') => {
    await editor(scope, text);
    await replace(input(scope, m.authored_language()), 'en');
    await replace(input(scope, m.authored_licence()), 'CC-BY-4.0');
    await replace(input(scope, m.authored_citation()), 'https://example.org/original-notes');
    await act(async () => user.click(within(scope).getByRole('checkbox', { name: m.authored_original() })));
  };
  return {
    window,
    host,
    root,
    render,
    user,
    within,
    AuthoredField,
    authoredFixture,
    authoredProperty,
    m,
    click,
    input,
    replace,
    editor,
    compose,
    close: async () => {
      await act(async () => root.unmount());
      mock.restore();
      await window.happyDOM.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('Authored forms have stable independent labels, local error destinations and isolated original drafts without native I/O', async () => {
  const view = await mountedFamily();
  const { window, host, render, user, within, AuthoredField, authoredFixture, m, input, replace, editor, click } = view;
  try {
    const first = authoredFixture();
    const second = authoredFixture();
    const [left, right] = await Promise.all([first.transport.read(), second.transport.read()]);
    const calls = [structuredClone(first.calls), structuredClone(second.calls)];
    const pair = () => (
      <>
        <AuthoredField key="first" initial={left} locale="en" transport={first.transport} confirm={first.confirm} />
        <AuthoredField key="second" initial={right} locale="en" transport={second.transport} confirm={second.confirm} />
      </>
    );
    await render(pair());
    const articles = within(host).getAllByRole('article') as HTMLElement[];
    expect(articles).toHaveLength(2);
    const allIds = Array.from(host.querySelectorAll('[id]'), (node) => node.id);
    expect(new Set(allIds).size).toBe(allIds.length);
    const associations = articles.map((article) => {
      const result = Array.from(article.querySelectorAll<HTMLLabelElement>('label[for]')).map((label) => {
        const control = window.document.getElementById(label.htmlFor);
        expect(control).not.toBeNull();
        expect(article.contains(control)).toBe(true);
        return [label.textContent, label.htmlFor];
      });
      expect(result.map(([name]) => name)).toEqual(
        expect.arrayContaining([
          m.candidate_field(),
          m.authored_language(),
          m.authored_licence(),
          m.authored_citation(),
          m.authored_original(),
        ]),
      );
      expect(within(article).getByRole('form', { name: m.authored_replacement() }).tagName).toBe('FORM');
      expect(article.querySelector('fieldset legend')!.textContent).toBe(m.authored_replacement());
      expect(input(article, m.authored_text()).textContent).toBe('');
      return result;
    });
    const a = articles[0]!;
    const b = articles[1]!;
    const language = input(a, m.authored_language());
    const label = Array.from(a.querySelectorAll<HTMLLabelElement>('label')).find(
      (label) => label.htmlFor === language.id,
    )!;
    await act(async () => user.click(label));
    expect(window.document.activeElement).toBe(language);
    await replace(language, 'not_a_language');
    await replace(input(a, m.authored_licence()), 'Unknown-Licence');
    await editor(a, 'First private original, never the current work.');
    await editor(b, 'Second private original, kept separate.');
    await replace(input(b, m.authored_language()), 'ja');
    await act(async () => user.click(within(b).getByRole('checkbox', { name: m.authored_original() })));
    await click(a, m.correction_submit());
    const error = within(a).getByRole('alert');
    expect(error.textContent).toContain(m.authored_invalid());
    expect(within(b).queryByRole('alert')).toBeNull();
    for (const link of Array.from(error.querySelectorAll<HTMLAnchorElement>('a'))) {
      const target = window.document.getElementById(decodeURIComponent(link.hash.slice(1)));
      expect(target).not.toBeNull();
      expect(a.contains(target)).toBe(true);
      expect(b.contains(target)).toBe(false);
      expect(target!.getAttribute('aria-invalid')).toBe('true');
      expect(target!.getAttribute('aria-describedby')!.split(' ')).toContain(link.closest('li')!.id);
      // Browser-native fragment focus is separately authored in the canonical keyboard story.
      target!.focus();
      expect(window.document.activeElement).toBe(target);
    }
    expect(within(a).getByRole('checkbox', { name: m.authored_original() }).getAttribute('aria-checked')).toBe('false');
    expect(within(b).getByRole('checkbox', { name: m.authored_original() }).getAttribute('aria-checked')).toBe('true');
    expect(input(b, m.authored_language()).value).toBe('ja');
    for (const [article, own, other] of [
      [a, 'First private original, never the current work.', 'Second private original, kept separate.'],
      [b, 'Second private original, kept separate.', 'First private original, never the current work.'],
    ] as const) {
      expect(input(article, m.authored_text()).textContent).toContain(own);
      const selected = within(article).getByRole('region', { name: m.authored_selected() });
      expect(selected.textContent).toContain('An aviator meets a young traveller in the desert.');
      expect(selected.textContent).not.toContain(own);
      expect(article.textContent).not.toContain(other);
    }
    await replace(input(b, m.authored_licence()), 'CC0-1.0');
    expect(within(a).getByRole('alert')).toBe(error);
    await render(pair());
    for (const [index, article] of articles.entries())
      expect(
        Array.from(article.querySelectorAll<HTMLLabelElement>('label[for]')).map((label) => [
          label.textContent,
          label.htmlFor,
        ]),
      ).toEqual(associations[index]);
    expect(first.calls).toEqual(calls[0]);
    expect(second.calls).toEqual(calls[1]);
  } finally {
    await view.close();
  }
});

test('Authored uncertain, stale, current-read recovery and denied private content retain their original native intent', async () => {
  const view = await mountedFamily();
  const { host, render, within, AuthoredField, authoredFixture, authoredProperty, m, input, compose, click, replace } =
    view;
  try {
    const fixture = authoredFixture('lost-response');
    const initial = await fixture.transport.read();
    let failRead = false;
    let settleRead: ((read: AuthoredRead) => void) | undefined;
    let deferRead = false;
    let denyDecision = false;
    const read = mock(async (...args: Parameters<typeof fixture.transport.read>) => {
      if (deferRead)
        return new Promise<AuthoredRead>((resolve) => {
          settleRead = resolve;
        });
      if (failRead) {
        failRead = false;
        throw new TypeError('Current text temporarily unavailable');
      }
      return fixture.transport.read(...args);
    });
    const propose = mock(fixture.transport.propose);
    const review = mock(fixture.transport.review);
    const confirm = mock(async (...args: Parameters<typeof fixture.confirm>) =>
      denyDecision ? { ok: false as const, reason: 'denied' as const } : fixture.confirm(...args),
    );
    const transport = { ...fixture.transport, read, propose, review };
    await render(<AuthoredField initial={initial} locale="en" transport={transport} confirm={confirm} />);
    await compose(host, 'An original frozen private draft.');
    expect(read).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    await click(host, m.correction_submit());
    expect(host.textContent).toContain(m.correction_unavailable());
    const request = structuredClone(propose.mock.calls[0]![0]);
    expect(request.session).toBe(initial.ok ? initial.session : undefined);
    expect(input(host, m.authored_language()).disabled).toBe(true);
    expect(host.querySelector('fieldset')!.disabled).toBe(true);
    expect(within(host).getByRole('button', { name: m.authored_discard() }).disabled).toBe(true);
    expect(input(host, m.authored_text()).textContent).toContain('An original frozen private draft.');
    expect(within(host).getByRole('region', { name: m.authored_selected() }).textContent).not.toContain(
      'frozen private',
    );
    await click(host, m.correction_retry());
    expect(propose.mock.calls.map(([command]) => command)).toEqual([request, request]);
    expect(host.textContent).toContain(m.authored_submitted());
    expect(host.textContent).not.toContain(m.candidate_selected());
    expect(within(host).queryByRole('button', { name: m.authored_discard() })).toBeNull();
    await click(host, m.correction_review());
    const candidate = within(host).getByRole('region', { name: m.authored_candidate() });
    expect(candidate.textContent).toContain('An original frozen private draft.');
    expect(candidate.textContent).toContain('CC-BY-4.0');
    expect(candidate.querySelector('details')).toBeNull();
    const reviews = review.mock.calls.length;
    expect(reviews).toBe(1);
    deferRead = true;
    await click(host, m.authored_reload_current_text());
    expect(within(host).queryByRole('region', { name: m.authored_selected() })).toBeNull();
    expect(within(host).getByRole('region', { name: m.authored_candidate() })).toBe(candidate);
    expect(host.querySelector('form')).toBeNull();
    deferRead = false;
    await act(async () => settleRead!(await fixture.transport.read()));
    expect(review).toHaveBeenCalledTimes(reviews);
    expect(candidate.textContent).toContain('An original frozen private draft.');
    failRead = true;
    await click(host, m.authored_reload_current_text());
    expect(host.textContent).toContain(m.catalogue_result_read_unavailable());
    expect(host.textContent).toContain(m.authored_submitted());
    expect(host.querySelector('form')).toBeNull();
    expect(host.textContent).not.toContain('An original frozen private draft.');
    const failedRead = read.mock.calls.at(-1);
    await click(host, m.catalogue_retry_loading_result());
    expect(read.mock.calls.at(-1)).toEqual(failedRead);
    expect(failedRead?.[0]).toBe(authoredProperty);
    expect(propose).toHaveBeenCalledTimes(2);
    expect(review).toHaveBeenCalledTimes(reviews);
    expect(confirm).not.toHaveBeenCalled();
    expect(input(host, m.authored_language()).value).toBe('en');
    expect(input(host, m.authored_licence()).value).toBe('CC-BY-4.0');
    expect(input(host, m.authored_citation()).value).toBe('https://example.org/original-notes');
    expect(within(host).getByRole('region', { name: m.authored_selected() }).textContent).toContain(
      'An aviator meets a young traveller in the desert.',
    );
    expect(host.textContent).not.toContain(m.candidate_selected());
    await click(host, m.correction_review());
    expect(within(host).getByRole('region', { name: m.authored_candidate() }).textContent).toContain(
      'An original frozen private draft.',
    );
    denyDecision = true;
    await click(host, m.candidate_accept());
    await act(async () => {
      const actions = within(host).getAllByRole('button', { name: m.candidate_accept() });
      actions.at(-1)!.click();
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(host.querySelector('form')).toBeNull();
    expect(host.textContent).not.toContain('An original frozen private draft.');
    expect(within(host).queryByRole('region', { name: m.authored_candidate() })).toBeNull();
    expect(within(host).getByRole('region', { name: m.authored_selected() }).textContent).toContain(
      'An aviator meets a young traveller in the desert.',
    );
    expect(fixture.calls.filter((call) => call.path.startsWith('/v1/documents/')).at(-1)?.authorization).toBeNull();

    await render(null);
    const stale = authoredFixture('stale');
    const staleRead = await stale.transport.read();
    const stalePropose = mock(stale.transport.propose);
    const staleReads = mock(stale.transport.read);
    await render(
      <AuthoredField
        initial={staleRead}
        locale="en"
        transport={{ ...stale.transport, read: staleReads, propose: stalePropose }}
        confirm={stale.confirm}
      />,
    );
    await compose(host, 'A draft retained for explicit stale review.');
    await click(host, m.correction_submit());
    const first = structuredClone(stalePropose.mock.calls[0]![0]);
    expect(host.textContent).toContain(m.correction_stale());
    expect(input(host, m.authored_language()).disabled).toBe(true);
    expect(within(host).getByRole('button', { name: m.correction_submit() }).disabled).toBe(true);
    expect(input(host, m.authored_text()).textContent).toContain('A draft retained for explicit stale review.');
    expect(within(host).getByRole('button', { name: m.authored_discard() }).disabled).toBe(true);
    expect(staleReads).not.toHaveBeenCalled();
    await click(host, m.authored_review_draft());
    expect(staleReads).toHaveBeenCalledTimes(1);
    expect(stalePropose).toHaveBeenCalledTimes(1);
    expect(input(host, m.authored_language()).disabled).toBe(false);
    expect(input(host, m.authored_licence()).value).toBe('CC-BY-4.0');
    await replace(input(host, m.authored_licence()), 'CC0-1.0');
    await click(host, m.correction_submit());
    const next = stalePropose.mock.calls[1]![0];
    expect(next.key).not.toBe(first.key);
    expect(next.statement.value).toMatchObject({ content: { licence: 'CC0-1.0' } });
    expect(stalePropose.mock.calls[0]![0]).toEqual(first);
  } finally {
    await view.close();
  }
}, 15_000);

test('Authored full supplied bodies, names, citations and provenance grow only with the supplied surface and never hydrate', async () => {
  const view = await mountedFamily();
  const { host, render, AuthoredField, authoredFixture, m, within } = view;
  try {
    const fixture = authoredFixture();
    const original = await fixture.transport.read();
    if (!original.ok || !original.selected || !original.body?.ok) throw new Error('Expected supplied current text');
    const title = `Long supplied name ${'UnbrokenTitle'.repeat(80)} 終わり`;
    const body = `Full body starts. ${'A complete paragraph about a traveller and friendship. '.repeat(100)} Full body ends.`;
    const attribution = `Supplied attribution ${'All of the credited contributors '.repeat(35)}`;
    const counts: number[] = [];
    const markupSizes: number[] = [];
    const calls = structuredClone(fixture.calls);
    for (const count of [1, 8, 32]) {
      const supplied = structuredClone(original) as Extract<AuthoredRead, { ok: true }>;
      supplied.public.subject.labels = { en: title };
      if (!supplied.body?.ok) throw new Error('Expected the authorized supplied body');
      const { id, subjectId, candidateId, revision, language, digest } = supplied.body.document;
      supplied.body = {
        ok: true,
        document: {
          id,
          subjectId,
          candidateId,
          revision,
          language,
          digest,
          availability: 'available',
          body: fromPlainText(body),
          source: {
            source: 'fixture',
            external_id: 'supplied-notes',
            record_revision: '1',
            digest,
            converter_revision: 'fixture',
            field_group: 'summary',
            references: [],
          },
          rights: { license: 'CC-BY-4.0', obligations: ['attribution'], attribution },
        },
      };
      const urls = Array.from(
        { length: count },
        (_, index) => `https://example.org/${index}/${'long-unbroken-citation'.repeat(40)}`,
      );
      supplied.selected!.references = urls.map((url, index) => ({
        hash: `supplied-${index}`,
        parts: [{ property: { id: 'schema:url', data_type: 'url' }, value: { type: 'value', content: url } }],
      }));
      // Unrelated definitions grow independently of the active field list. Rendering
      // must address only the type's supplied fields, not enumerate the whole release.
      for (let index = 0; index < count * 30; index++)
        supplied.release.properties[`unrelated-${index}`] = supplied.release.properties[supplied.property]!;
      let propertyReads = 0;
      supplied.release.properties = new Proxy(supplied.release.properties, {
        get(target, key) {
          propertyReads++;
          return Reflect.get(target, key);
        },
        ownKeys() {
          throw new Error('Authored presentation must not enumerate unrelated definitions');
        },
      });
      await render(
        <AuthoredField
          key={count}
          initial={supplied}
          locale="en"
          transport={fixture.transport}
          confirm={fixture.confirm}
        />,
      );
      expect(within(host).getByRole('link', { name: title }).textContent).toBe(title);
      const selected = within(host).getByRole('region', { name: m.authored_selected() });
      expect(within(selected).getByText(body).closest('details')).toBeNull();
      const licence = within(selected).getByText(/CC-BY-4.0/);
      expect(licence.closest('details')).toBeNull();
      expect(within(selected).getByText(attribution).closest('details')).toBeNull();
      expect(selected.textContent!.indexOf(body)).toBeLessThan(selected.textContent!.indexOf('CC-BY-4.0'));
      const details = selected.querySelector('details')!;
      await act(async () => {
        details.open = true;
      });
      expect(details.querySelectorAll('li[data-slot="list-row"]')).toHaveLength(count);
      for (const url of urls) {
        const link = within(details).getByRole('link', { name: url });
        expect(link.getAttribute('href')).toBe(url);
        expect(link.textContent).toBe(url);
      }
      expect(within(host).getByRole('textbox', { name: m.authored_text() }).textContent).toBe('');
      const form = host.querySelector('form')!;
      expect(form.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"])')).toHaveLength(3);
      expect(new Set(Array.from(host.querySelectorAll('[id]'), (element) => element.id)).size).toBe(
        host.querySelectorAll('[id]').length,
      );
      counts.push(propertyReads);
      markupSizes.push(host.innerHTML.length);
      expect(fixture.calls).toEqual(calls);
    }
    expect(new Set(counts).size).toBe(1);
    // Count/byte witness for linear supplied citation rendering, not a native engine or timing proof.
    expect(markupSizes[2]! - markupSizes[0]!).toBeLessThanOrEqual((markupSizes[1]! - markupSizes[0]!) * 5);
    expect(fixture.calls).toEqual(calls);
  } finally {
    await view.close();
  }
});

test('only the current discard question resets its original replacement, preserving siblings, public text and keyboard focus', async () => {
  const view = await mountedFamily();
  const {
    host,
    window,
    render,
    user,
    within,
    AuthoredField,
    authoredFixture,
    authoredProperty,
    m,
    input,
    compose,
    click,
    replace,
  } = view;
  try {
    const fixture = authoredFixture();
    const initial = await fixture.transport.read();
    if (!initial.ok) throw new Error('Expected authored fixture');
    // Local two-field metadata seam: native proposal and comparison interfaces remain unchanged.
    const other = 'test:other-authored';
    initial.release.properties[other] = structuredClone(initial.release.properties[authoredProperty]!);
    initial.release.types[initial.public.subject.type]!.properties.push(other);
    const read = mock(async (property = authoredProperty) => ({ ...initial, property }));
    await render(
      <AuthoredField
        initial={initial}
        locale="en"
        transport={{ ...fixture.transport, read }}
        confirm={fixture.confirm}
      />,
    );
    const field = async (property: string) =>
      act(async () => user.selectOptions(within(host).getByRole('combobox'), property));
    const retainedClick = (name: string) => {
      const node = within(host).getByRole('button', { name });
      const key = Object.keys(node).find((key) => key.startsWith('__reactProps$'))!;
      return Reflect.get(node, key).onClick as (event: { detail: number }) => void;
    };
    await compose(host, 'First field retained.');
    await field(other);
    await compose(host, 'Second field discarded.');
    const selected = within(host).getByRole('region', { name: m.authored_selected() });
    const publicMarkup = selected.innerHTML;
    const calls = structuredClone(fixture.calls);
    await click(host, m.authored_discard());
    expect(host.textContent).toContain(m.authored_discard_warning());
    expect(window.document.activeElement).toBe(within(host).getByRole('button', { name: m.authored_discard() }));
    const oldConfirm = retainedClick(m.authored_discard_confirm());
    const oldCancel = retainedClick(m.authored_keep_draft());
    await act(async () => user.tab());
    await act(async () => {
      oldCancel({ detail: 0 });
      oldConfirm({ detail: 0 });
    });
    expect(input(host, m.authored_text()).textContent).toContain('Second field discarded.');
    expect(window.document.activeElement).toBe(within(host).getByRole('button', { name: m.authored_discard() }));
    await replace(input(host, m.authored_citation()), 'https://example.org/new-private-notes');
    await click(host, m.authored_discard());
    const confirmed = retainedClick(m.authored_discard_confirm());
    await act(async () => {
      oldConfirm({ detail: 0 });
      oldCancel({ detail: 0 });
    });
    expect(host.textContent).toContain(m.authored_discard_warning());
    expect(input(host, m.authored_citation()).value).toBe('https://example.org/new-private-notes');
    await act(async () => {
      await user.tab();
      await user.tab();
      await user.keyboard('{Enter}');
    });
    await act(async () => {
      await Bun.sleep(20);
    });
    expect(input(host, m.authored_text()).textContent).toBe('');
    expect(window.document.activeElement).toBe(input(host, m.authored_text()));
    for (const name of [m.authored_language(), m.authored_licence(), m.authored_citation()])
      expect(input(host, name).value).toBe('');
    expect(within(host).getByRole('checkbox', { name: m.authored_original() }).getAttribute('aria-checked')).toBe(
      'false',
    );
    expect(selected.innerHTML).toBe(publicMarkup);
    expect(fixture.calls).toEqual(calls);
    expect(read).toHaveBeenCalledTimes(1);
    await compose(host, 'New second field retained.');
    await act(async () => confirmed({ detail: 0 }));
    expect(input(host, m.authored_text()).textContent).toContain('New second field retained.');
    await click(host, m.authored_discard());
    await click(host, m.authored_discard_confirm());
    expect(input(host, m.authored_text()).textContent).toBe('');
    expect(window.document.activeElement).not.toBe(input(host, m.authored_text()));
    await field(authoredProperty);
    expect(input(host, m.authored_text()).textContent).toContain('First field retained.');
    expect(input(host, m.authored_language()).value).toBe('en');
    expect(within(host).getByRole('checkbox', { name: m.authored_original() }).getAttribute('aria-checked')).toBe(
      'true',
    );
    await field(other);
    await act(async () => user.click(within(host).getByRole('checkbox', { name: m.authored_original() })));
    await click(host, m.authored_discard());
    expect(host.textContent).not.toContain(m.authored_discard_warning());
    expect(within(host).getByRole('checkbox', { name: m.authored_original() }).getAttribute('aria-checked')).toBe(
      'false',
    );
  } finally {
    await view.close();
  }
}, 15_000);

for (const action of ['reload', 'field'])
  test(`${action} retires current text before I/O and recovers private replacements after denial`, async () => {
    const view = await mountedFamily();
    const { host, render, user, within, AuthoredField, authoredFixture, authoredProperty, m, compose, click, input } =
      view;
    try {
      const fixture = authoredFixture();
      const initial = await fixture.transport.read();
      if (!initial.ok) throw new Error('Expected authored fixture');
      const other = 'test:other-authored';
      initial.release.properties[other] = structuredClone(initial.release.properties[authoredProperty]!);
      initial.release.types[initial.public.subject.type]!.properties.push(other);
      let settle!: (value: AuthoredRead) => void;
      let defer = true;
      const read = mock(async (property = authoredProperty) =>
        defer
          ? new Promise<AuthoredRead>((resolve) => {
              settle = resolve;
            })
          : { ...initial, property },
      );
      const propose = mock(fixture.transport.propose);
      const transport = { ...fixture.transport, read, propose };
      const show = (value = initial) =>
        render(<AuthoredField initial={value} locale="en" transport={transport} confirm={fixture.confirm} />);
      await show();
      await compose(host, 'Private replacement survives a denied reload.');
      const props = (element: Element) =>
        Reflect.get(
          element,
          Object.keys(element).find((key) => key.startsWith('__reactProps$'))!,
        );
      const savedSubmit = props(host.querySelector('form')!).onSubmit;
      const savedReload = props(within(host).getByRole('button', { name: m.authored_reload_current_text() })).onClick;
      const editor = host.querySelector('[contenteditable="true"]')!;
      let fiber = Reflect.get(
        editor,
        Object.keys(editor).find((key) => key.startsWith('__reactFiber$'))!,
      );
      let savedChange!: (value: ReturnType<typeof fromPlainText>) => void;
      for (; fiber; fiber = fiber.return)
        if (fiber.memoizedProps?.label === m.authored_text() && fiber.memoizedProps.onChange)
          savedChange = fiber.memoizedProps.onChange;
      expect(savedChange).toBeFunction();
      if (action === 'reload') await click(host, m.authored_reload_current_text());
      else await act(async () => user.selectOptions(within(host).getByRole('combobox'), other));
      expect(host.innerHTML).not.toContain('An aviator meets');
      expect(host.innerHTML).not.toContain('Private replacement survives');
      expect(host.querySelector('header a')).toBeNull();
      expect(read.mock.calls[0]).toEqual([action === 'field' ? other : authoredProperty, initial.session]);
      await act(async () => settle({ ok: false, reason: 'denied' }));
      expect(host.textContent).toContain(m.catalogue_result_read_denied());
      expect(host.innerHTML).not.toContain('An aviator meets');
      defer = false;
      await click(host, m.catalogue_retry_loading_result());
      if (action === 'field')
        await act(async () => user.selectOptions(within(host).getByRole('combobox'), authoredProperty));
      const reads = read.mock.calls.length;
      await act(async () => {
        savedReload();
        savedSubmit({ preventDefault() {} });
        savedChange(fromPlainText('Retired editor emission.'));
      });
      expect(read).toHaveBeenCalledTimes(reads);
      expect(propose).not.toHaveBeenCalled();
      expect(input(host, m.authored_text()).textContent).toContain('Private replacement survives a denied reload.');
      expect(input(host, m.authored_language()).value).toBe('en');
      expect(input(host, m.authored_licence()).value).toBe('CC-BY-4.0');
      defer = true;
      await click(host, m.authored_reload_current_text());
      const fresh = structuredClone(initial);
      if (!fresh.body?.ok) throw new Error('Expected current body');
      fresh.body.document.body = fromPlainText('Fresh authoritative current text.');
      await show(fresh);
      await act(async () => settle(initial));
      expect(host.textContent).toContain('Fresh authoritative current text.');
      expect(host.innerHTML).not.toContain('An aviator meets');
    } finally {
      await view.close();
    }
  });

test('a Literary reading refusal retains authored originals while retiring old callbacks and results', async () => {
  const view = await mountedFamily();
  const { host, render, AuthoredField, authoredFixture, m, compose, click, input } = view;
  const { CatalogueCurrentReading } = await import('../src/features/catalogue/editor-lifetime');
  try {
    const fixture = authoredFixture();
    const initial = await fixture.transport.read();
    const read = mock(fixture.transport.read);
    let settle!: (result: Awaited<ReturnType<typeof fixture.transport.propose>>) => void;
    const propose = mock(async (command: Parameters<typeof fixture.transport.propose>[0]) =>
      propose.mock.calls.length === 1
        ? new Promise<Awaited<ReturnType<typeof fixture.transport.propose>>>((resolve) => {
            settle = resolve;
          })
        : fixture.transport.propose(command),
    );
    const show = (visible: boolean) =>
      render(
        <CatalogueCurrentReading visible={visible} ready={visible} revision="literary">
          <AuthoredField
            initial={initial}
            locale="en"
            transport={{ ...fixture.transport, read, propose }}
            confirm={fixture.confirm}
          />
        </CatalogueCurrentReading>,
      );
    await show(true);
    await compose(host, 'Retained original literary prose.');
    const form = host.querySelector('form')!;
    const savedSubmit = Reflect.get(
      form,
      Object.keys(form).find((key) => key.startsWith('__reactProps$'))!,
    ).onSubmit;
    await click(host, m.correction_submit());
    const original = structuredClone(propose.mock.calls[0]![0]);
    await show(false);
    expect(host.innerHTML).toBe('');
    await act(async () => {
      settle({ ok: true, candidate: 'retired-candidate', revision: 2 });
    });
    expect(host.innerHTML).toBe('');
    await show(true);
    expect(read.mock.calls).toEqual([[initial.ok ? initial.property : '', initial.ok ? initial.session : undefined]]);
    expect(input(host, m.authored_text()).textContent).toContain('Retained original literary prose.');
    expect(input(host, m.authored_language()).disabled).toBe(true);
    expect(host.textContent).toContain(m.correction_unavailable());
    expect(host.innerHTML).not.toContain('retired-candidate');
    await act(async () => {
      await savedSubmit({ preventDefault() {} });
    });
    expect(propose).toHaveBeenCalledTimes(1);
    await click(host, m.correction_retry());
    expect(propose.mock.calls.map(([command]) => command)).toEqual([original, original]);
    expect(original.session).toBe(initial.ok ? initial.session : undefined);
  } finally {
    await view.close();
  }
});
