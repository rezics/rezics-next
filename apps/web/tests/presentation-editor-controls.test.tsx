// UNRUN: mounted controls, recovery and reader-retirement assertions authored for integration.
// Phone geometry, painted focus, native acceptance, SSR and full growth verification remain deferred.
import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act } from 'react';
import { PROFILE_FORMAT, profileDigest, type CompositionDocument, type PresentationProfile } from '@rezics/composition';
import type { PublishInput, PublishResult } from '../src/features/pages/curate';
import type { CurationRead } from '../src/features/pages/curate-actions';
import type { CurationEditorTransport } from '../src/features/pages/curate-view-editor';

const longType = `schema:${'LongTemplate'.repeat(16)}`;
const longRoute = `/${'long-route-key-'.repeat(14)}end`;
const addedRoute = `/independent-${'a'.repeat(180)}`;
const empty: CompositionDocument = { root: { props: {} }, content: [] };
const profile: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: { views: { overview: empty, details: empty } },
  bases: [],
  types: [{ type: longType, views: { overview: empty, details: empty } }],
  routes: [{ route: longRoute, document: empty }],
};
const reader = (index: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(index).padStart(12, '0')}`;
const readFor = (subject: string, value = profile, head = 7): Extract<CurationRead, { ok: true }> => ({
  ok: true,
  reader: subject,
  profile: value,
  head,
  digest: profileDigest(value),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

async function mountedEditors() {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/curate/presentation', width: 390, height: 844 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLIFrameElement: window.HTMLIFrameElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    matchMedia: window.matchMedia.bind(window),
    scrollTo: window.scrollTo.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { PresentationViewEditor } = await import('../src/features/pages/curate-view-editor');
  const { m } = await import('../src/paraglide/messages.js');
  const runtime = await import('../src/paraglide/runtime.js');
  const originalLocale = runtime.getLocale();
  runtime.setLocale('en', { reload: false });
  const storybook = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const initial = [readFor(reader(1)), readFor(reader(2))];
  const subjects = [reader(1), reader(2)];
  const reads: { panel: number; reader: string }[] = [];
  const publishes: { panel: number; reader: string; input: PublishInput }[] = [];
  const readResults: ((subject: string) => Promise<CurationRead>)[] = initial.map((value) => async () => value);
  const publishResults: (() => Promise<PublishResult>)[] = initial.map(() => async () => ({
    ok: false,
    reason: 'unavailable',
    outcome: 'unknown',
  }));
  const transports: CurationEditorTransport[] = initial.map((_, panel) => ({
    read: async (subject) => {
      reads.push({ panel, reader: subject });
      return readResults[panel]!(subject);
    },
    publish: async (input, subject) => {
      publishes.push({ panel, reader: subject, input: structuredClone(input) });
      return publishResults[panel]!();
    },
  }));
  const show = () =>
    act(async () =>
      root.render(
        <>
          {initial.map((value, index) => (
            <div key={index} data-editor-panel={index}>
              <PresentationViewEditor
                initial={value}
                locale="en"
                transport={transports[index]!}
                observedSession={{ state: 'signed-in', subject: subjects[index]! }}
              />
            </div>
          ))}
        </>,
      ),
    );
  const panel = (index: number) => host.querySelector(`[data-editor-panel="${index}"]`)!;
  const control = (index: number, name: string) => {
    const region =
      name === m.curation_template() || name === m.curation_view()
        ? [...panel(index).querySelectorAll('section')].find(
            (node) => node.getAttribute('aria-label') === m.curation_templates(),
          )!
        : panel(index).querySelector('form')!;
    const labels = [...region.querySelectorAll('label')].filter((node) => node.textContent === name);
    expect(labels).toHaveLength(1);
    const label = labels[0]!;
    const field = label.control!;
    expect(field).not.toBeNull();
    expect(region.contains(field)).toBe(true);
    expect(window.document.getElementById(label.htmlFor)).toBe(field);
    return field as InstanceType<typeof window.HTMLSelectElement> | InstanceType<typeof window.HTMLInputElement>;
  };
  const button = (index: number, name: string) => {
    const matches = [...panel(index).querySelectorAll('button')].filter((node) => node.textContent?.trim() === name);
    expect(matches, name).toHaveLength(1);
    return matches[0]!;
  };
  const click = (node: Parameters<typeof user.click>[0]) => act(async () => user.click(node));
  const select = (index: number, name: string, value: string) =>
    act(async () => user.selectOptions(control(index, name), value));
  const type = (index: number, value: string) => act(async () => user.type(control(index, m.curation_key()), value));
  const settle = async (ready: () => boolean) => {
    for (let count = 0; count < 150 && !ready(); count++)
      await act(async () => {
        await Bun.sleep(10);
      });
    expect(ready()).toBe(true);
  };
  const ids = () => [...host.querySelectorAll('[id]')].map((node) => node.id);
  const uniqueIds = () => expect(new Set(ids()).size).toBe(ids().length);
  const closeEditor = async (index: number) => {
    await settle(() =>
      [...panel(index).querySelectorAll('button')].some((node) => node.textContent?.trim() === m.curation_close()),
    );
    const close = button(index, m.curation_close());
    close.focus();
    await act(async () => user.keyboard('{Enter}'));
    expect(panel(index).querySelector(`section[aria-label="${m.curation_editor()}"]`)).toBeNull();
  };
  return {
    window,
    host,
    m,
    user,
    initial,
    subjects,
    reads,
    publishes,
    readResults,
    publishResults,
    show,
    panel,
    control,
    button,
    click,
    select,
    type,
    settle,
    ids,
    uniqueIds,
    closeEditor,
    async cleanup() {
      await act(async () => root.unmount());
      runtime.setLocale(originalLocale, { reload: false });
      mock.restore();
      await window.happyDOM.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('simultaneous presentation editors own their labels, exact choices, keyboard controls and distinct recovery', async () => {
  const h = await mountedEditors();
  const { m } = h;
  try {
    await h.show();
    h.uniqueIds();
    const identities = [0, 1].map((index) =>
      [m.curation_template(), m.curation_view(), m.curation_scope(), m.curation_key()].map(
        (name) => h.control(index, name).id,
      ),
    );
    for (const index of [0, 1]) {
      expect(h.control(index, m.curation_template()).tagName).toBe('SELECT');
      expect(h.control(index, m.curation_view()).tagName).toBe('SELECT');
      expect(h.control(index, m.curation_scope()).tagName).toBe('SELECT');
      expect(h.control(index, m.curation_key()).tagName).toBe('INPUT');
      expect(h.control(index, m.curation_template()).value).toBe(JSON.stringify({ scope: 'generic', key: null }));
      expect(h.control(index, m.curation_view()).value).toBe('overview');
      expect(h.panel(index).textContent).toContain(m.curation_saved());
      expect(h.panel(index).querySelector('[role="alert"]')).toBeNull();
      expect(h.button(index, `generic: ${m.curation_generic()}`).disabled).toBe(false);
    }
    const savedSummary = h.panel(0).querySelector('summary')!;
    await act(async () => h.user.tab());
    expect(h.window.document.activeElement).toBe(savedSummary);
    expect(savedSummary.className).toContain('focus-visible:ring-2');
    expect(savedSummary.className).toContain('min-h-11');
    expect(savedSummary.closest('details')!.open).toBe(false);
    await h.click(savedSummary);
    expect(savedSummary.closest('details')!.open).toBe(true);
    expect(savedSummary.closest('details')!.textContent).toContain(
      m.presentation_editor_version_reference({ head: 7, digest: h.initial[0]!.digest }),
    );
    await h.click(savedSummary);
    await act(async () => h.user.tab());
    expect(h.window.document.activeElement).toBe(h.button(0, m.curation_publish()));
    const generic = h.button(0, `generic: ${m.curation_generic()}`);
    generic.focus();
    await act(async () => h.user.keyboard('{Enter}'));
    await h.closeEditor(0);

    await h.select(0, m.curation_template(), JSON.stringify({ scope: 'type', key: longType }));
    await h.select(0, m.curation_view(), 'details');
    expect(h.control(0, m.curation_template()).value).toBe(JSON.stringify({ scope: 'type', key: longType }));
    expect(h.control(0, m.curation_view()).value).toBe('details');
    const template = h.control(0, m.curation_template());
    const description = h.window.document.getElementById(template.getAttribute('aria-describedby')!)!;
    expect(description.textContent).toBe(`${m.curation_type()}: ${longType}`);
    expect(description.closest('details')).toBeNull();
    expect(description.className).toContain('[overflow-wrap:anywhere]');
    expect(h.control(1, m.curation_template()).value).toBe(JSON.stringify({ scope: 'generic', key: null }));
    expect(h.control(1, m.curation_view()).value).toBe('overview');
    await h.closeEditor(0);
    expect(h.button(0, `type: ${longType}`).className).toContain('whitespace-normal');

    await h.select(1, m.curation_template(), JSON.stringify({ scope: 'route', key: longRoute }));
    expect(h.control(1, m.curation_template()).value).toBe(JSON.stringify({ scope: 'route', key: longRoute }));
    expect([...h.control(1, m.curation_view()).querySelectorAll('option')].map((node) => node.value)).toEqual([
      'overview',
    ]);
    await h.closeEditor(1);
    await h.select(1, m.curation_scope(), 'route');
    expect(h.control(1, m.curation_scope()).value).toBe('route');
    await h.type(1, addedRoute);
    expect(h.control(1, m.curation_key()).value).toBe(addedRoute);
    expect(h.control(0, m.curation_scope()).value).toBe('type');
    expect(h.control(0, m.curation_key()).value).toBe('');
    const keyDescription = h.control(1, m.curation_key()).getAttribute('aria-describedby')!.split(' ').at(-1)!;
    expect(h.window.document.getElementById(keyDescription)!.textContent).toBe(addedRoute);
    const add = h.button(1, m.curation_add());
    add.focus();
    expect(h.window.document.activeElement).toBe(add);
    await act(async () => h.user.keyboard('{Enter}'));
    expect(h.control(1, m.curation_template()).value).toBe(JSON.stringify({ scope: 'route', key: addedRoute }));
    expect(h.control(1, m.curation_key()).value).toBe('');
    expect([...h.control(1, m.curation_scope()).querySelectorAll('option')].map((option) => option.value)).toEqual([
      'base',
      'type',
      'route',
    ]);
    await h.select(1, m.curation_scope(), 'base');
    await h.type(1, 'schema:Thing');
    await h.click(h.button(1, m.curation_add()));
    expect(h.control(1, m.curation_template()).value).toBe(JSON.stringify({ scope: 'base', key: 'schema:Thing' }));
    expect([...h.control(1, m.curation_template()).querySelectorAll('option')].map((option) => option.value)).toContain(
      JSON.stringify({ scope: 'base', key: 'schema:Thing' }),
    );
    expect([...h.control(0, m.curation_template()).querySelectorAll('option')].map((node) => node.value)).not.toContain(
      JSON.stringify({ scope: 'route', key: addedRoute }),
    );
    expect(h.control(0, m.curation_view()).value).toBe('details');
    await h.closeEditor(1);
    await h.select(1, m.curation_template(), JSON.stringify({ scope: 'route', key: addedRoute }));
    h.uniqueIds();
    for (const index of [0, 1])
      expect(
        [m.curation_template(), m.curation_view(), m.curation_scope(), m.curation_key()].map(
          (name) => h.control(index, name).id,
        ),
      ).toEqual(identities[index]);
    expect(h.reads).toEqual([]);
    expect(h.publishes).toEqual([]);

    const resolver = [...h.panel(1).querySelectorAll('summary')].find(
      (node) => node.textContent === m.presentation_editor_resolver_details(),
    )!;
    resolver.focus();
    expect(h.window.document.activeElement).toBe(resolver);
    await h.click(resolver);
    expect(resolver.closest('details')!.open).toBe(true);
    expect(resolver.closest('details')!.textContent).toContain(m.curation_fallback());
    expect(h.panel(1).textContent).toContain(m.curation_unsaved());
    await h.click(h.button(1, m.curation_reload()));
    const dialog = h.window.document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain(m.curation_reload_warning());
    expect(h.reads).toEqual([]);
    const keep = [...dialog.querySelectorAll('button')].find((node) => node.textContent === m.curation_keep())!;
    keep.focus();
    await act(async () => h.user.keyboard(' '));
    await h.settle(() => !h.window.document.querySelector('[role="alertdialog"]'));
    expect(h.control(1, m.curation_template()).value).toBe(JSON.stringify({ scope: 'route', key: addedRoute }));
    h.readResults[1] = async () => ({ ok: false, reason: 'unavailable' });
    await h.click(h.button(1, m.curation_reload()));
    await h.settle(() => !!h.window.document.querySelector('[role="alertdialog"]'));
    const confirm = [...h.window.document.querySelector('[role="alertdialog"]')!.querySelectorAll('button')].find(
      (node) => node.textContent === m.curation_discard_reload(),
    )!;
    await h.click(confirm);
    await h.settle(() => !!h.panel(1).textContent?.includes(m.curation_unavailable()));
    expect(h.panel(1).textContent).toContain(m.curation_unsaved());
    expect(h.panel(1).textContent).not.toContain(m.curation_unknown());
    expect(h.reads).toEqual([{ panel: 1, reader: reader(2) }]);

    h.publishResults[0] = async () => ({
      ok: false,
      reason: 'invalid',
      errors: [{ pointer: '/generic/views/overview/root/props', code: 'invalid' }],
    });
    await h.click(h.button(0, m.curation_publish()));
    expect(h.panel(0).textContent).toContain(m.curation_invalid_retained());
    expect(h.button(0, m.curation_new_intent()).disabled).toBe(true);
    expect(h.panel(0).textContent).not.toContain(m.curation_unknown());
    expect(h.panel(0).textContent).not.toContain(m.curation_unavailable());
    expect(h.button(0, m.curation_correct()).disabled).toBe(false);
    await h.click(h.button(1, m.curation_publish()));
    expect(h.panel(1).textContent).toContain(m.curation_unknown());
    expect(h.panel(1).textContent).not.toContain(m.curation_invalid_retained());
    expect(h.button(1, m.curation_retry_original()).disabled).toBe(false);
    const recovery = [...h.panel(1).querySelectorAll('section')].find(
      (node) => node.getAttribute('aria-label') === m.curation_recovery(),
    )!;
    const originalDetails = [...recovery.querySelectorAll('summary')].find(
      (node) => node.textContent === m.presentation_editor_publication_details(),
    )!;
    originalDetails.focus();
    expect(h.window.document.activeElement).toBe(originalDetails);
    await h.click(originalDetails);
    expect(originalDetails.closest('details')!.open).toBe(true);
    await act(async () => h.user.tab());
    const originalProfile = originalDetails.closest('details')!.querySelector('pre')!;
    expect(h.window.document.activeElement).toBe(originalProfile);
    expect(JSON.parse(originalProfile.textContent!)).toEqual(h.publishes[1]!.input.profile);
    expect(
      h.publishes.map(({ panel, reader: subject, input }) => ({ panel, subject, head: input.expectedHead })),
    ).toEqual([
      { panel: 0, subject: reader(1), head: 7 },
      { panel: 1, subject: reader(2), head: 7 },
    ]);
    expect(h.publishes[0]!.input.profile).toEqual(profile);
    expect(h.publishes[1]!.input.profile.routes.map((item) => item.route)).toContain(addedRoute);
    expect(h.publishes[1]!.input.profile.bases.map(({ base }) => base)).toEqual(['schema:Thing']);
    expect(h.reads).toHaveLength(1);
    h.uniqueIds();
  } finally {
    await h.cleanup();
  }
}, 15000);

test('retiring one editor drops its draft and late publication without disturbing the other editor or its focus', async () => {
  const h = await mountedEditors();
  const { m } = h;
  try {
    const publication = deferred<PublishResult>();
    const admission = deferred<CurationRead>();
    h.publishResults[0] = () => publication.promise;
    h.readResults[0] = () => admission.promise;
    await h.show();
    const otherIds = [...h.panel(1).querySelectorAll('[id]')].map((node) => node.id);
    await h.select(0, m.curation_scope(), 'route');
    await h.type(0, addedRoute);
    await h.click(h.button(0, m.curation_add()));
    await h.closeEditor(0);
    await h.click(h.button(0, m.curation_publish()));
    expect(h.publishes).toHaveLength(1);
    expect(h.reads).toHaveLength(0);
    h.subjects[0] = reader(3);
    await h.show();
    expect(h.panel(0).querySelector('select')).toBeNull();
    expect(h.panel(0).textContent).not.toContain(addedRoute);
    expect(h.reads).toEqual([{ panel: 0, reader: reader(3) }]);
    const fresh = readFor(reader(3), { ...profile, routes: [{ route: '/fresh-reader', document: empty }] }, 30);
    await act(async () => admission.resolve(fresh));
    await h.settle(() => !!h.panel(0).querySelector('select'));
    const focus = h.control(1, m.curation_template());
    focus.focus();
    const statuses = [...h.host.querySelectorAll('[role="status"]')].map((node) => node.textContent);
    await act(async () =>
      publication.resolve({ ok: true, digest: profileDigest(h.publishes[0]!.input.profile), head: 8 }),
    );
    expect(h.window.document.activeElement).toBe(focus);
    expect([...h.host.querySelectorAll('[role="status"]')].map((node) => node.textContent)).toEqual(statuses);
    expect(h.panel(0).textContent).toContain('/fresh-reader');
    expect(h.panel(0).textContent).not.toContain(addedRoute);
    expect(h.panel(0).textContent).not.toContain(m.presentation_editor_published());
    expect(h.panel(0).textContent).not.toContain(m.curation_unknown());
    expect(h.panel(0).textContent).toContain(m.curation_saved());
    expect(h.control(1, m.curation_template()).value).toBe(JSON.stringify({ scope: 'generic', key: null }));
    expect([...h.panel(1).querySelectorAll('[id]')].map((node) => node.id)).toEqual(otherIds);
    expect(h.reads).toHaveLength(1);
    expect(h.publishes).toHaveLength(1);
    h.uniqueIds();
  } finally {
    await h.cleanup();
  }
}, 15000);

test('removing a selected keyed template requires confirmation and explicit publication', async () => {
  const h = await mountedEditors();
  const { m } = h;
  try {
    await h.show();
    const selected = JSON.stringify({ scope: 'type', key: longType });
    await h.select(0, m.curation_template(), selected);
    await h.closeEditor(0);
    await h.click(h.button(0, m.curation_remove()));
    let dialog = h.window.document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain(m.curation_remove_title({ template: `${m.curation_type()}: ${longType}` }));
    await h.click([...dialog.querySelectorAll('button')].find((button) => button.textContent === m.action_cancel())!);
    await h.settle(() => !h.window.document.querySelector('[role="alertdialog"]'));
    expect(h.control(0, m.curation_template()).value).toBe(selected);
    expect(h.publishes).toEqual([]);

    await h.click(h.button(0, m.curation_remove()));
    await h.settle(() => !!h.window.document.querySelector('[role="alertdialog"]'));
    dialog = h.window.document.querySelector('[role="alertdialog"]')!;
    await h.click([...dialog.querySelectorAll('button')].find((button) => button.textContent === m.curation_remove())!);
    await h.settle(() => !h.window.document.querySelector('[role="alertdialog"]'));
    expect(h.control(0, m.curation_template()).value).toBe(JSON.stringify({ scope: 'generic', key: null }));
    expect(h.publishes).toEqual([]);
    h.publishResults[0] = async () => ({
      ok: true,
      digest: profileDigest({ ...h.initial[0]!.profile, types: [] }),
      head: 8,
    });
    await h.click(h.button(0, m.curation_publish()));
    expect(h.publishes[0]!.input.profile.types).toEqual([]);
    expect(h.publishes[0]!.input.profile.routes).toEqual(h.initial[0]!.profile.routes);
  } finally {
    await h.cleanup();
  }
});

test('growing only supplied template options preserves both identities and makes no read or publication', async () => {
  const h = await mountedEditors();
  try {
    await h.show();
    const identities = h.ids();
    for (const count of [1, 8, 64]) {
      const supplied = {
        ...profile,
        routes: Array.from({ length: count }, (_, index) => ({
          route: `${longRoute}/${index}`,
          document: empty,
        })),
      };
      h.initial[0] = readFor(reader(1), supplied);
      await h.show();
      const options = [...h.control(0, h.m.curation_template()).querySelectorAll('option')];
      expect(options).toHaveLength(count + 2);
      expect(options.at(-1)!.value).toBe(JSON.stringify({ scope: 'route', key: `${longRoute}/${count - 1}` }));
      expect(options.at(-1)!.textContent).toBe(`${h.m.curation_route()}: ${longRoute}/${count - 1}`);
      expect(h.control(1, h.m.curation_template()).querySelectorAll('option')).toHaveLength(3);
      expect(h.ids()).toEqual(identities);
      expect(h.reads).toEqual([]);
      expect(h.publishes).toEqual([]);
      h.uniqueIds();
    }
  } finally {
    await h.cleanup();
  }
});
