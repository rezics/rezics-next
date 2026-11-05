import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PROFILE_FORMAT,
  VIEWS,
  profileDigest,
  resolveView,
  type CompositionDocument,
  type PresentationProfile,
  type View,
} from '@rezics/composition';
import { addCompanionView, resetCompanionView, viewOf, type Template } from '../src/features/pages/curate';
import { draftPublicationProfile, editView, presentationDraft } from '../src/features/pages/curate-view-editor-state';
import { fromComposition } from '../src/features/pages/editor-config';
import { CurationPublication } from '../src/features/pages/curation-publish';

const document = (text: string): CompositionDocument => ({
  root: { props: {} },
  content: [{ type: 'Heading', props: { id: 'heading', level: 2, text: { en: text } } }],
});
const initial: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: { views: { overview: document('generic'), relations: document('generic relations') } },
  bases: [{ base: 'schema:Work', views: { overview: document('work'), relations: document('base relations') } }],
  types: [{ type: 'schema:Book', views: { overview: document('book'), details: document('details') } }],
  routes: [{ route: '/', document: document('home') }],
};
const template: Template = { scope: 'type', key: 'schema:Book' };
const target = { type: 'schema:Book', bases: ['schema:Work'] };
const reader = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10';

test('a curator adds, edits, publishes and confirms reset of one companion view', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/curate/presentation' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLSelectElement: window.HTMLSelectElement,
    Event: window.Event,
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
  const { createRoot } = await import('react-dom/client');
  const { CurationCompanionViews } = await import('../src/features/pages/curation-companion-views');
  const { m } = await import('../src/paraglide/messages.js');
  const runtime = await import('../src/paraglide/runtime.js');
  const originalLocale = runtime.getLocale();
  runtime.setLocale('en', { reload: false });
  const viewNames = Object.fromEntries(VIEWS.map((view) => [view, view])) as Record<View, string>;
  let currentProfile = initial;
  let publicationResult: PresentationProfile | null = null;
  let publicationKey = 0;
  let pendingPublication: Promise<void> | null = null;
  const publication = new CurationPublication(
    reader,
    {
      publish: async (input) => {
        publicationResult = input.profile;
        return { ok: true, digest: profileDigest(input.profile), head: input.expectedHead + 1 };
      },
      read: async () => ({ ok: false, reason: 'unavailable' }),
    },
    () => `publication-${++publicationKey}`,
  );
  const output = window.document.createElement('main');
  window.document.body.append(output);
  const root = createRoot(output as unknown as HTMLElement);

  function Harness() {
    const [profile, setProfile] = useState(initial);
    const [selection, setSelection] = useState({ template, view: 'overview' as View });
    function publish() {
      const selection = { template, view: 'relations' as View };
      const source = viewOf(profile, selection.template, selection.view)!;
      const data = fromComposition(source);
      data.content[0]!.props.text = { en: 'edited companion' };
      const draft = editView(
        {
          ...presentationDraft({ ok: true, reader, profile: initial, head: 7, digest: profileDigest(initial) }),
          profile,
          selection,
        },
        selection,
        data,
      );
      const next = draftPublicationProfile(draft)!;
      pendingPublication = publication.start(next, 7).then((confirmation) => {
        if (confirmation) setProfile(confirmation.intent.profile);
      });
    }
    return (
      <>
        <CurationCompanionViews
          profile={profile}
          selection={selection}
          viewNames={viewNames}
          onAdd={(view, source) => {
            setProfile((current) => addCompanionView(current, template, view, source));
            setSelection({ template, view });
          }}
          onReset={(view) => {
            setProfile((current) => resetCompanionView(current, template, view));
            setSelection({ template, view: 'overview' });
          }}
        />
        <button data-publish type="button" onClick={publish}>
          Publish
        </button>
        <output data-profile>{JSON.stringify(profile)}</output>
        <output data-resolved>{resolveView(profile, target, 'relations')?.scope ?? 'none'}</output>
      </>
    );
  }

  const select = async (index: number, value: string) =>
    act(async () => {
      const fields = output.querySelectorAll('select');
      const field = fields[index]!;
      field.value = value;
      field.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
  const click = async (button: HTMLButtonElement) => act(async () => button.click());
  const button = (name: string, parent: ParentNode = output) => {
    const matches = [...parent.querySelectorAll('button')].filter((item) => item.textContent?.trim() === name);
    expect(matches, name).toHaveLength(1);
    return matches[0] as HTMLButtonElement;
  };

  try {
    await act(async () => root.render(createElement(Harness)));
    const companion = output.querySelector(`section[aria-label="${m.curation_companion_views()}"]`)!;
    const add = button(m.curation_companion_add(), companion);
    expect(add.disabled).toBe(true);
    expect(
      viewOf(
        JSON.parse(output.querySelector('[data-profile]')!.textContent!) as PresentationProfile,
        template,
        'relations',
      ),
    ).toBeUndefined();
    await select(0, 'relations');
    expect(add.disabled).toBe(true);
    await select(1, 'overview');
    expect(add.disabled).toBe(false);
    expect([...companion.querySelectorAll('select')][1]!.querySelector('option[value="empty"]')).not.toBeNull();
    await click(add);

    let profile = JSON.parse(output.querySelector('[data-profile]')!.textContent!) as PresentationProfile;
    expect(viewOf(profile, template, 'relations')).toEqual(viewOf(initial, template, 'overview'));
    expect(viewOf(profile, template, 'relations')).not.toBe(viewOf(profile, template, 'overview'));
    expect(viewOf(profile, template, 'details')).toEqual(viewOf(initial, template, 'details'));
    expect(output.querySelector('[data-resolved]')!.textContent).toBe('type');

    await act(async () => {
      button('Publish').click();
      await pendingPublication;
    });
    profile = JSON.parse(output.querySelector('[data-profile]')!.textContent!) as PresentationProfile;
    expect(publicationResult?.types[0]!.views?.relations?.content[0]!.props.text).toEqual({ en: 'edited companion' });
    expect(viewOf(profile, template, 'details')).toEqual(viewOf(initial, template, 'details'));

    const reset = button(m.curation_companion_reset(), companion);
    await click(reset);
    let dialog = window.document.querySelector('[role="alertdialog"]')!;
    await click(button(m.curation_companion_reset_cancel(), dialog));
    await act(async () => {
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
    });
    expect(window.document.activeElement).toBe(reset);
    expect(
      viewOf(
        JSON.parse(output.querySelector('[data-profile]')!.textContent!) as PresentationProfile,
        template,
        'relations',
      ),
    ).toBeDefined();
    await click(button(m.curation_companion_reset(), companion));
    dialog = window.document.querySelector('[role="alertdialog"]')!;
    await click(button(m.curation_companion_reset_confirm(), dialog));

    profile = JSON.parse(output.querySelector('[data-profile]')!.textContent!) as PresentationProfile;
    expect(viewOf(profile, template, 'relations')).toBeUndefined();
    expect(viewOf(profile, template, 'overview')).toEqual(viewOf(initial, template, 'overview'));
    expect(viewOf(profile, template, 'details')).toEqual(viewOf(initial, template, 'details'));
    expect(output.querySelector('[data-resolved]')!.textContent).toBe('base');
    const empty = addCompanionView(profile, template, 'contents', 'empty');
    expect(viewOf(empty, template, 'contents')).toEqual({ root: { props: {} }, content: [] });
    expect(
      renderToStaticMarkup(
        createElement(CurationCompanionViews, {
          profile,
          selection: { template: { scope: 'route', key: '/' }, view: 'overview' },
          viewNames,
          onAdd: () => {},
          onReset: () => {},
        }),
      ),
    ).toBe('');
  } finally {
    await act(async () => root.unmount());
    runtime.setLocale(originalLocale, { reload: false });
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
