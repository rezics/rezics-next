import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { PROFILE_FORMAT, profileDigest, type CompositionDocument, type PresentationProfile } from '@rezics/composition';
import type { PublishInput } from '../src/features/pages/curate';

test('default presentation editor takes a native invalid publication to its actual template view and editable field without replaying invalid intent', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/curate/presentation', width: 1280, height: 900 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    HTMLElement: window.HTMLElement,
    HTMLIFrameElement: window.HTMLIFrameElement,
    Element: window.Element,
    Node: window.Node,
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
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
  const { PresentationViewEditor } = await import('../src/features/pages/curate-view-editor');
  const { m } = await import('../src/paraglide/messages.js');
  const document = (id: string): CompositionDocument => ({
    root: { props: {} },
    content: [{ type: 'Heading', props: { id, level: 2, text: { en: 'Reading notes', ja: '読書ノート' } } }],
  });
  const profile: PresentationProfile = {
    format: PROFILE_FORMAT,
    generic: { views: { overview: document('overview'), details: document('generic-details') } },
    bases: [],
    types: [{ type: 'schema:Book', views: { overview: document('book'), details: document('details') } }],
    routes: [],
  };
  const initial = {
    ok: true as const,
    reader: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10',
    profile,
    head: 7,
    digest: profileDigest(profile),
  };
  const attempts: PublishInput[] = [];
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const lookupButton = (label: string) =>
    [...host.querySelectorAll('button')].find(
      (item) =>
        item.textContent?.trim() === label ||
        item.getAttribute('aria-label') === label ||
        item.getAttribute('title') === label,
    );
  const button = (label: string) => {
    const match = lookupButton(label);
    expect(match).toBeDefined();
    return match!;
  };
  const settle = async (ready: () => boolean) => {
    for (let count = 0; count < 150 && !ready(); count++)
      await act(async () => {
        await Bun.sleep(10);
      });
    expect(
      ready(),
      [...host.querySelectorAll('button')]
        .map((item) => [item.textContent, item.getAttribute('aria-label'), item.getAttribute('title')])
        .toString(),
    ).toBe(true);
  };
  const click = async (label: string) => {
    await act(async () => {
      button(label).click();
    });
  };
  const templateControl = (name: string) => {
    const region = [...host.querySelectorAll('section')].find(
      (section) => section.getAttribute('aria-label') === m.curation_templates(),
    );
    return ([...(region?.querySelectorAll('label') ?? [])].find((label) => label.textContent === name)?.control ??
      null) as InstanceType<typeof window.HTMLSelectElement> | null;
  };
  const select = async (name: string, value: string) => {
    await act(async () => {
      const control = templateControl(name)! as InstanceType<typeof window.HTMLSelectElement>;
      control.value = value;
      control.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
  };
  const textField = (name: string) => [...host.querySelectorAll('textarea')].find((field) => field.name === name);
  const edit = async (name: string, value: string) => {
    await act(async () => {
      const field = textField(name)!;
      field.focus();
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
      field.dispatchEvent(new window.Event('input', { bubbles: true }));
      field.blur();
    });
  };
  const heading = async (id: string) => {
    await settle(() => !!host.querySelector(`[data-puck-layer-tree-id="${id}"]`));
    await act(async () => {
      const row = host.querySelector(`[data-puck-layer-tree-id="${id}"]`)!;
      [...row.querySelectorAll('button')].find((control) => control.textContent === 'Heading')!.click();
    });
    await settle(() => !!textField('text.en'));
  };
  try {
    const route = createRootRoute({
      component: () =>
        createElement(PresentationViewEditor, {
          initial,
          locale: 'en',
          transport: {
            read: async () => initial,
            publish: async (input) => {
              attempts.push(structuredClone(input));
              return attempts.length === 1
                ? {
                    ok: false,
                    reason: 'invalid',
                    errors: [{ pointer: '/types/0/views/details/content/0/props/text/en', code: 'invalid' }],
                  }
                : { ok: true, digest: profileDigest(input.profile), head: input.expectedHead + 1 };
            },
          },
        }),
    });
    const router = createRouter({
      routeTree: route,
      history: createMemoryHistory({ initialEntries: ['/en/curate/presentation'] }),
    });
    await router.load();
    await act(async () => {
      root.render(createElement(RouterProvider, { router }));
    });
    expect((templateControl(m.curation_view()) as InstanceType<typeof window.HTMLSelectElement>).value).toBe(
      'overview',
    );
    expect((templateControl(m.curation_template()) as InstanceType<typeof window.HTMLSelectElement>).value).toBe(
      JSON.stringify({ scope: 'generic', key: null }),
    );
    await click(m.curation_publish());
    expect(attempts).toHaveLength(1);
    expect(host.textContent).toContain(m.curation_invalid_retained());
    expect([...host.querySelectorAll('button')].some((item) => item.textContent === m.curation_retry_original())).toBe(
      false,
    );

    // Later edits belong to the current editor, even though the error describes the retained intent.
    await select(m.curation_view(), 'overview');
    await heading('overview');
    await edit('text.en', 'Later overview edit');
    await edit('text.fr', 'Brouillon');
    await edit('text.fr', '');
    await select(m.curation_template(), JSON.stringify({ scope: 'type', key: 'schema:Book' }));
    await select(m.curation_view(), 'details');
    await heading('details');
    await edit('text.ja', '後からの編集');
    await edit('text.fr', 'Détails');
    await edit('text.fr', '');
    await select(m.curation_view(), 'overview');
    await select(m.curation_template(), JSON.stringify({ scope: 'generic', key: null }));

    await click(m.curation_correct());
    await settle(() => window.document.activeElement === textField('text.en') && !!textField('text.en'));
    expect((templateControl(m.curation_template()) as InstanceType<typeof window.HTMLSelectElement>).value).toBe(
      JSON.stringify({ scope: 'type', key: 'schema:Book' }),
    );
    expect((templateControl(m.curation_view()) as InstanceType<typeof window.HTMLSelectElement>).value).toBe('details');
    expect(textField('text.ja')!.value).toBe('後からの編集');
    expect(textField('text.fr')!.value).toBe('');
    expect(host.textContent).toContain(m.curation_correction_later());
    expect(attempts).toHaveLength(1);
    await edit('text.en', 'Corrected heading');
    await click(m.curation_publish());
    await settle(() => attempts.length === 2 && !!host.textContent?.includes(m.curation_published({ head: 8 })));
    expect(attempts[1]!.keys.publish).not.toBe(attempts[0]!.keys.publish);
    expect(attempts[1]!.keys.activate).not.toBe(attempts[0]!.keys.activate);
    expect(attempts[1]!.expectedHead).toBe(7);
    expect(attempts[1]!.profile).not.toEqual(attempts[0]!.profile);
    const submitted = attempts[1]!.profile;
    expect('views' in submitted.generic && submitted.generic.views.overview.content[0]!.props.text).toEqual({
      en: 'Later overview edit',
      ja: '読書ノート',
    });
    expect(submitted.types[0]!.views!.details!.content[0]!.props).toEqual({
      id: 'details',
      level: 2,
      text: { en: 'Corrected heading', ja: '後からの編集' },
    });
    expect(host.textContent).toContain(m.curation_saved());
    await select(m.curation_view(), 'details');
    await heading('details');
    expect(textField('text.fr')!.value).toBe('');
    await select(m.curation_template(), JSON.stringify({ scope: 'generic', key: null }));
    await select(m.curation_view(), 'overview');
    await heading('overview');
    expect(textField('text.en')!.value).toBe('Later overview edit');
    expect(textField('text.fr')!.value).toBe('');
  } finally {
    await act(async () => root.unmount());
    mock.restore();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}, 15000);

// Authored against the actual recovery composition; intentionally UNRUN in this delivery.
test('recovery controls preserve exact original retries, deliberate review choices, valid replacements and mounted visit ownership', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/curate/presentation', width: 390, height: 844 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { CurationPublication } = await import('../src/features/pages/curation-publish');
  const { CurationPublicationRecovery } = await import('../src/features/pages/curation-publish-view');
  const { m } = await import('../src/paraglide/messages.js');
  const original: PresentationProfile = {
    format: PROFILE_FORMAT,
    generic: {
      root: { props: { appearance: { density: 'comfortable' } } },
      content: [{ type: 'Text', props: { id: 'intro', text: { en: 'Original proposal', ja: '元の提案' } } }],
    },
    bases: [],
    types: [],
    routes: [],
  };
  const later: PresentationProfile = {
    ...original,
    routes: [
      {
        route: '/later',
        document: {
          root: { props: {} },
          content: [{ type: 'Text', props: { id: 'later', text: { en: 'Later draft only' } } }],
        },
      },
    ],
  };
  const active = {
    ok: true as const,
    reader: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10',
    head: 9,
    digest: profileDigest(original),
    profile: original,
  };
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  let unmounted = false;
  const confirmations: import('../src/features/pages/curation-publish').PublicationConfirmation[] = [];
  const reviews: {
    active: import('../src/features/pages/curation-publish').ActiveCuration;
    choice: 'keep' | 'discard';
  }[] = [];
  const corrected: string[] = [];
  const button = (label: string) => {
    const result = [...host.querySelectorAll('button')].find((node) => node.textContent === label);
    expect(result, label).toBeDefined();
    return result!;
  };
  const click = async (label: string) => {
    await act(async () => button(label).click());
  };
  const handler = (node: Element) => {
    const key = Object.keys(node).find((name) => name.startsWith('__reactProps$'))!;
    return (node as unknown as Record<string, { onClick(): void }>)[key]!.onClick;
  };
  async function render(
    publication: InstanceType<typeof CurationPublication>,
    visit: import('../src/features/pages/curation-publish').CurationPublicationVisit,
    profile = later,
    head = 7,
  ) {
    await act(async () =>
      root.render(
        createElement(CurationPublicationRecovery, {
          publication,
          visit,
          profile,
          head,
          onPublished: (confirmation) => confirmations.push(confirmation),
          onReviewed: (active, choice) => reviews.push({ active, choice }),
          correction: {
            describe: () => 'Reading introduction · English',
            correct: (pointer) => corrected.push(pointer),
          },
        }),
      ),
    );
  }
  try {
    const inputs: PublishInput[] = [];
    let finish!: (value: import('../src/features/pages/curate').PublishResult) => void;
    const transport = {
      publish: async (input: PublishInput): Promise<import('../src/features/pages/curate').PublishResult> => {
        inputs.push(input);
        if (inputs.length === 1) return { ok: false, reason: 'unavailable', outcome: 'unknown' };
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      read: async () => ({ ...active, head: 8 }),
    };
    const publication = new CurationPublication(active.reader, transport);
    const visit = publication.activate(transport);
    await visit.start(original, 7);
    const retained = publication.getSnapshot().intent!;
    await render(publication, visit);
    expect(host.textContent).toContain(m.curation_review_no_active());
    expect(reviews).toEqual([]);
    expect(confirmations).toEqual([]);
    await click(m.curation_reload_head());
    expect(host.textContent).toContain(m.curation_compare());
    expect(host.textContent).toContain(m.curation_unknown());
    expect([...host.querySelectorAll('button')].some((node) => node.textContent === m.curation_reconcile())).toBe(
      false,
    );
    expect([...host.querySelectorAll('button')].some((node) => node.textContent === m.curation_discard())).toBe(false);
    expect(publication.getSnapshot().intent).toBe(retained);
    const retry = handler(button(m.curation_retry_original()) as unknown as Element);
    await click(m.curation_retry_original());
    expect(host.textContent).toContain(m.curation_review_working());
    expect([...host.querySelectorAll('button')].every((node) => node.disabled)).toBe(true);
    await act(async () => retry());
    expect(inputs).toHaveLength(2);
    expect(inputs[1]!.profile).toBe(retained.profile);
    expect(inputs[1]!.keys).toBe(retained.keys);
    expect(inputs[1]!.expectedHead).toBe(7);
    await act(async () => finish({ ok: true, head: 8, digest: profileDigest(original) }));
    expect(confirmations).toHaveLength(1);
    expect(host.textContent).toContain(m.presentation_editor_published());
    expect(host.querySelector('details')!.open).toBe(false);
    expect(later.routes[0]!.route).toBe('/later');

    for (const choice of ['keep', 'discard'] as const) {
      let failed = true;
      const staleTransport = {
        publish: async () => ({ ok: false as const, reason: 'stale' as const }),
        read: async () => (failed ? { ok: false as const, reason: 'unavailable' as const } : active),
      };
      const stale = new CurationPublication(active.reader, staleTransport);
      const currentVisit = stale.activate(staleTransport);
      await currentVisit.start(original, 7);
      await render(stale, currentVisit);
      expect(host.textContent).toContain(m.curation_review_read_failed());
      expect(host.querySelector(`[aria-label="${m.curation_compare()}"]`)).toBeNull();
      expect([...host.querySelectorAll('button')].some((node) => node.textContent === m.curation_discard())).toBe(
        false,
      );
      failed = false;
      await click(m.curation_reload_head());
      expect(host.textContent).toContain(m.curation_review_discard_help());
      expect(host.textContent).toContain(m.curation_review_help());
      await click(choice === 'keep' ? m.curation_reconcile() : m.curation_discard());
      expect(reviews.at(-1)).toEqual({ active: { ...active, profile: choice === 'keep' ? later : original }, choice });
      expect(stale.getSnapshot().intent).toBeNull();
      expect(confirmations).toHaveLength(1);
    }

    const revisedInputs: PublishInput[] = [];
    const invalidTransport = {
      publish: async (input: PublishInput) => {
        revisedInputs.push(input);
        return revisedInputs.length === 1
          ? {
              ok: false as const,
              reason: 'invalid' as const,
              errors: [{ pointer: '/generic/content/0/props/text/en', code: 'invalid' }],
            }
          : { ok: true as const, head: input.expectedHead + 1, digest: profileDigest(input.profile) };
      },
      read: async () => active,
    };
    const invalid = new CurationPublication(active.reader, invalidTransport);
    const invalidVisit = invalid.activate(invalidTransport);
    await invalidVisit.start(original, 7);
    await render(invalid, invalidVisit, original);
    expect(button(m.curation_new_intent()).disabled).toBe(true);
    expect(host.textContent).toContain(m.curation_review_revision_required());
    expect([...host.querySelectorAll('button')].some((node) => node.textContent === m.curation_retry_original())).toBe(
      false,
    );
    expect(host.querySelector('code')!.textContent).toBe('/generic/content/0/props/text/en — invalid');
    expect(host.querySelector('code')!.closest('details')!.open).toBe(false);
    await click(m.curation_correct());
    expect(corrected).toEqual(['/generic/content/0/props/text/en']);
    const invalidDraft = structuredClone(later);
    invalidDraft.routes[0]!.document!.content[0]!.props.text = 'x'.repeat(2001);
    await render(invalid, invalidVisit, invalidDraft, 11);
    expect(button(m.curation_new_intent()).disabled).toBe(true);
    await render(invalid, invalidVisit, later, 11);
    expect(button(m.curation_new_intent()).disabled).toBe(false);
    expect(host.textContent).toContain(m.curation_review_replace_help());
    await click(m.curation_new_intent());
    expect(revisedInputs).toHaveLength(2);
    expect(revisedInputs[1]!.expectedHead).toBe(11);
    expect(revisedInputs[1]!.profile).toEqual(later);
    expect(revisedInputs[1]!.keys.publish).not.toBe(revisedInputs[0]!.keys.publish);
    expect(revisedInputs[1]!.keys.activate).not.toBe(revisedInputs[0]!.keys.activate);

    const retired = new CurationPublication(active.reader, transport);
    const retiredVisit = retired.activate(transport);
    // A definite refused publication is still retained and may be retried only by the current visit.
    const refusedTransport = {
      ...transport,
      publish: async () => ({ ok: false as const, reason: 'forbidden' as const }),
    };
    retired.setTransport(refusedTransport);
    await retiredVisit.start(original, 7);
    await render(retired, retiredVisit);
    const obsolete = handler(button(m.curation_retry_original()) as unknown as Element);
    await act(async () => retired.retire(retiredVisit));
    const count = inputs.length;
    await act(async () => obsolete());
    expect(inputs).toHaveLength(count);
    expect(retired.getSnapshot().intent!.profile).toEqual(original);

    let finalCalls = 0;
    let completeFinal!: (value: import('../src/features/pages/curate').PublishResult) => void;
    const finalTransport = {
      read: async () => active,
      publish: async (): Promise<import('../src/features/pages/curate').PublishResult> => {
        if (++finalCalls === 1) return { ok: false, reason: 'unavailable', outcome: 'unknown' };
        return new Promise((resolve) => {
          completeFinal = resolve;
        });
      },
    };
    const final = new CurationPublication(active.reader, finalTransport);
    const finalVisit = final.activate(finalTransport);
    await finalVisit.start(original, 7);
    await render(final, finalVisit);
    await click(m.curation_retry_original());
    const beforeUnmount = confirmations.length;
    await act(async () => {
      root.unmount();
      unmounted = true;
    });
    await act(async () => completeFinal({ ok: true, head: 8, digest: profileDigest(original) }));
    expect(final.getSnapshot().result).toMatchObject({ ok: true, head: 8 });
    expect(confirmations).toHaveLength(beforeUnmount);
  } finally {
    if (!unmounted) await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
