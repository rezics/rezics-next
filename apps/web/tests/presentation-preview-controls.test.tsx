import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import type { PresentationPreview, PresentationPreviewInput } from '../src/features/pages/presentation-preview';
import recorded from '../src/kernel/recorded/subject.json';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const subject = recorded.subject.id;
const realm = '00000000-0000-4000-8000-000000000007';
const longRoute = `/${'published-catalogue/'.repeat(12)}catalogue`;
const document: CompositionDocument = {
  root: { props: {} },
  content: [
    { type: 'SubjectHeader', props: { id: 'header' } },
    { type: 'Summary', props: { id: 'summary' } },
  ],
};
function published(locale: string, route?: string): Extract<PresentationPreview, { ok: true }> {
  const context = {
    id: recorded.subject.context,
    population: { kind: 'realm' as const, id: realm, title: 'Published Realm with long readable identity '.repeat(8) },
  };
  const routeDocument: CompositionDocument = {
    root: { props: {} },
    content: [{ type: 'Heading', props: { id: 'published', level: 1, text: { en: 'Published catalogue' } } }],
  };
  return {
    ok: true,
    target: route ? { route } : { subject, realm },
    locale,
    head: 17,
    page: {
      subject: route ? null : subject,
      ...(!route ? { context } : {}),
      profile: `sha256:${'a'.repeat(64)}`,
      template: route ? { scope: 'route', key: route } : { scope: 'base', key: 'schema:CreativeWork' },
      document: route ? routeDocument : document,
      reads: route
        ? {}
        : Object.fromEntries(
            Object.keys(planReads(platformRegistry, document, { subject, context }).reads).map((key) => [
              key,
              { status: 200, body: recorded },
            ]),
          ),
    },
  };
}

async function harness(locale = 'en') {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: `https://site.test/${locale}/curate/presentation`, width: 390, height: 844 });
  const unexpectedReads: unknown[] = [];
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    HTMLIFrameElement: window.HTMLIFrameElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    ShadowRoot: window.ShadowRoot,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    matchMedia: window.matchMedia.bind(window),
    fetch: async (input: unknown) => {
      unexpectedReads.push(input);
      throw new Error('Unexpected preview renderer read');
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { FeatureSlotsProvider } = await import('../src/shell/feature-slots');
  const { PresentationPreviewPanel } = await import('../src/features/pages/presentation-preview-view');
  const { m } = await import('../src/paraglide/messages.js');
  const storybook = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { within } = await import(Bun.resolveSync('@testing-library/dom', storybook));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', storybook));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const curator = { state: 'signed-in', csrfToken: 'curator-private', subject: 'curator' };
  client.setQueryData(['session'], curator);
  const calls: {
    panel: 'left' | 'right';
    input: PresentationPreviewInput;
    pending: ReturnType<typeof deferred<PresentationPreview>>;
  }[] = [];
  const read = (panel: 'left' | 'right') => (input: PresentationPreviewInput) => {
    const pending = deferred<PresentationPreview>();
    calls.push({ panel, input: structuredClone(input), pending });
    return pending.promise;
  };
  const leftRead = read('left');
  const rightRead = read('right');
  let incarnation = 0;
  const render = async (left: PresentationPreview | null = published(locale), fresh = false) => {
    if (fresh) incarnation++;
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <FeatureSlotsProvider
            subjectPurchase={{
              publicRegion: () => <p>Curator public host slot</p>,
              privateRegion: () => <p>Curator private host slot</p>,
            }}
          >
            {left && (
              <PresentationPreviewPanel key={`left-${incarnation}`} locale={locale} read={leftRead} initial={left} />
            )}
            <PresentationPreviewPanel
              key="right"
              locale={locale}
              read={rightRead}
              initial={published(locale, longRoute)}
            />
          </FeatureSlotsProvider>
        </QueryClientProvider>,
      ),
    );
  };
  const o = { locale: locale as never };
  const canvas = within(host as unknown as HTMLElement);
  const panels = () => canvas.getAllByRole('region', { name: m.presentation_preview_title({}, o) }) as HTMLElement[];
  const control = (panel: HTMLElement, name: string) => within(panel).getByLabelText(name) as HTMLInputElement;
  const click = (panel: HTMLElement, name: string) =>
    act(async () => user.click(within(panel).getByRole('button', { name })));
  const edit = (panel: HTMLElement, name: string, value: string) =>
    act(async () => {
      const input = control(panel, name);
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  const finish = async () => {
    await act(async () => root.unmount());
    client.clear();
    mock.restore();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  return {
    window,
    host,
    client,
    curator,
    user,
    m,
    o,
    calls,
    unexpectedReads,
    render,
    panels,
    control,
    click,
    edit,
    within,
    finish,
  };
}

// UNRUN actual-renderer regressions. DOM class assertions do not establish browser layout, native or SSR proof.
for (const locale of ['en', 'zh-Hant']) {
  test(`independent published forms resolve their own labels/help and keyboard evidence in ${locale}`, async () => {
    const h = await harness(locale);
    const { m, o, user, window, calls, within } = h;
    try {
      await h.render();
      const [left, right] = h.panels() as [HTMLElement, HTMLElement];
      const allIds = [...h.host.querySelectorAll('[id]')].map((node) => node.id);
      expect(new Set(allIds).size).toBe(allIds.length);
      for (const panel of [left, right]) {
        for (const node of [panel, ...panel.querySelectorAll('[aria-labelledby], [aria-describedby]')]) {
          for (const attr of ['aria-labelledby', 'aria-describedby']) {
            for (const id of node.getAttribute(attr)?.split(' ') ?? []) {
              const target = window.document.getElementById(id);
              expect(target).not.toBeNull();
              expect(panel.contains(target)).toBe(true);
            }
          }
        }
        for (const label of panel.querySelectorAll('label')) {
          const field = window.document.getElementById(label.htmlFor);
          expect(panel.contains(field)).toBe(true);
          expect(field?.matches('input, select')).toBe(true);
          await act(async () => user.click(label));
          expect(window.document.activeElement).toBe(field);
        }
      }
      const address = h.control(left, m.presentation_preview_address({}, o));
      const stableAddressId = address.id;
      expect(address.required).toBe(true);
      expect(address.maxLength).toBe(36);
      expect(address.autocomplete).toBe('off');
      expect(address.spellcheck).toBe(false);
      expect(h.control(left, m.presentation_preview_realm({}, o)).maxLength).toBe(36);
      expect(h.control(right, m.presentation_preview_address({}, o)).maxLength).toBe(256);
      expect(within(right).queryByLabelText(m.presentation_preview_realm({}, o))).toBeNull();
      expect(left.textContent).toContain(m.presentation_preview_help({}, o));
      expect(left.textContent).toContain(m.presentation_editor_preview_current({}, o));
      expect(h.host.querySelector('[data-slot="subject-header"]')).not.toBeNull();
      expect(h.host.textContent).not.toContain('Curator public host slot');
      expect(h.host.textContent).not.toContain('Curator private host slot');
      expect(h.host.querySelector('[data-slot="subject-purchase"]')).toBeNull();
      expect(h.client.getQueryData(['session'])).toEqual(h.curator);
      expect(h.host.querySelector('script[type="application/ld+json"], title')).toBeNull();
      expect(calls).toHaveLength(0);

      for (const panel of [left, right]) {
        for (const details of panel.querySelectorAll('details')) {
          expect(details.open).toBe(false);
          const summary = details.querySelector('summary')!;
          expect(summary.className).toContain('min-h-11');
          expect(summary.className).toContain('wrap-anywhere');
          expect(summary.className).toContain('focus-visible:outline-ring');
          await act(async () => {
            summary.focus();
            await user.keyboard('{Enter}');
          });
          expect(details.open).toBe(true);
          expect(window.document.activeElement).toBe(summary);
          if (details.querySelector('dd, pre')) {
            const references = [...details.querySelectorAll<HTMLElement>('dd, pre')];
            for (const reference of references) {
              expect(reference.tabIndex).toBe(0);
              expect(reference.className).toContain('select-text');
              expect(reference.className).toContain('break-all');
              await act(async () => user.tab());
              expect(window.document.activeElement).toBe(reference);
            }
          }
          // Native Space activation closes the same disclosure without any inspection read.
          await act(async () => {
            summary.focus();
            await user.keyboard(' ');
          });
          expect(details.open).toBe(false);
        }
      }
      for (const [label, value] of [
        [m.presentation_preview_head({}, o), '17'],
        [m.presentation_preview_profile({}, o), published(locale).page.profile],
        [m.presentation_preview_template({}, o), `${m.presentation_preview_scope_base({}, o)}: schema:CreativeWork`],
        [m.presentation_preview_terminal({}, o), subject],
        [m.presentation_preview_context({}, o), published(locale).page.context!.id],
      ]) {
        const term = [...left.querySelectorAll('dt')].find((node) => node.textContent === label)!;
        expect(term.nextElementSibling!.textContent).toContain(value!);
      }
      expect(right.querySelector('dl')!.textContent).toContain(longRoute);
      expect(JSON.parse(left.querySelector('pre')!.textContent!)).toEqual(document);
      expect(right.querySelector('pre')!.textContent).toContain('Published catalogue');
      expect(calls).toHaveLength(0);
      await h.render();
      expect(h.control(left, m.presentation_preview_address({}, o)).id).toBe(stableAddressId);

      const rightPage = right.querySelector('[data-slot="published-presentation-preview"]');
      await act(async () => user.selectOptions(h.control(left, m.presentation_preview_target({}, o)), 'route'));
      expect(h.control(left, m.presentation_preview_address({}, o)).id).toBe(stableAddressId);
      expect(h.control(left, m.presentation_preview_address({}, o)).value).toBe('');
      expect(within(left).queryByLabelText(m.presentation_preview_realm({}, o))).toBeNull();
      expect(left.querySelector('[data-slot="published-presentation-preview"]')).toBeNull();
      expect(right.querySelector('[data-slot="published-presentation-preview"]')).toBe(rightPage);
      await h.edit(left, m.presentation_preview_address({}, o), '  /deliberate  ');
      await act(async () => {
        h.control(left, m.presentation_preview_address({}, o)).focus();
        await user.keyboard('{Enter}');
      });
      expect(calls.map(({ panel, input }) => ({ panel, input }))).toEqual([
        { panel: 'left', input: { target: { route: '/deliberate' }, locale } },
      ]);
      expect(left.querySelector('form')!.getAttribute('aria-busy')).toBe('true');
      expect(
        within(left)
          .getByRole('button', { name: m.presentation_preview_loading({}, o) })
          .hasAttribute('disabled'),
      ).toBe(true);
      await act(async () => calls[0]!.pending.resolve(published(locale, '/deliberate')));
      expect(left.textContent).toContain(m.presentation_editor_preview_current({}, o));
      await h.click(left, m.presentation_preview_close({}, o));
      expect(left.querySelector('[data-slot="published-presentation-preview"]')).toBeNull();
      expect(h.control(left, m.presentation_preview_address({}, o)).value).toBe('  /deliberate  ');
      expect(right.querySelector('[data-slot="published-presentation-preview"]')).toBe(rightPage);
      await act(async () => user.selectOptions(h.control(left, m.presentation_preview_target({}, o)), 'subject'));
      expect(h.control(left, m.presentation_preview_realm({}, o)).value).toBe('');
      // Programmatic values exercise trim independently of the native 36-character editing bound.
      await h.edit(left, m.presentation_preview_address({}, o), ` ${subject} `);
      await h.edit(left, m.presentation_preview_realm({}, o), ` ${realm} `);
      await h.click(left, m.presentation_preview_inspect({}, o));
      expect(calls[1]!.input).toEqual({ target: { subject, realm }, locale });
      await h.click(left, m.presentation_preview_close({}, o));
      await h.edit(left, m.presentation_preview_realm({}, o), '   ');
      await h.click(left, m.presentation_preview_inspect({}, o));
      expect(calls[2]!.input).toEqual({ target: { subject }, locale });
      await act(async () => calls[2]!.pending.resolve(published(locale)));
      await act(async () => calls[1]!.pending.resolve(published(locale, '/retired')));
      expect(left.querySelector('pre')!.textContent).toContain('SubjectHeader');
      expect(left.querySelector('pre')!.textContent).not.toContain('Published catalogue');
      expect(calls).toHaveLength(3);
      expect(right.querySelector('[data-slot="published-presentation-preview"]')).toBe(rightPage);
      const leftPage = left.querySelector('[data-slot="published-presentation-preview"]');
      await act(async () => user.selectOptions(h.control(right, m.presentation_preview_target({}, o)), 'subject'));
      expect(h.control(right, m.presentation_preview_address({}, o)).value).toBe('');
      expect(h.control(right, m.presentation_preview_realm({}, o)).id).not.toBe(
        h.control(left, m.presentation_preview_realm({}, o)).id,
      );
      const rightRealm = h.control(right, m.presentation_preview_realm({}, o));
      expect(right.contains(window.document.getElementById(rightRealm.getAttribute('aria-describedby')!))).toBe(true);
      await h.edit(right, m.presentation_preview_address({}, o), subject);
      await h.click(right, m.presentation_preview_inspect({}, o));
      expect(calls[3]!.panel).toBe('right');
      expect(calls[3]!.input).toEqual({ target: { subject }, locale });
      await act(async () => calls[3]!.pending.resolve(published(locale)));
      await h.click(right, m.presentation_preview_close({}, o));
      expect(right.querySelector('[data-slot="published-presentation-preview"]')).toBeNull();
      expect(left.querySelector('[data-slot="published-presentation-preview"]')).toBe(leftPage);
      expect(h.control(left, m.presentation_preview_address({}, o)).value).toBe(` ${subject} `);
      expect(calls).toHaveLength(4);
      expect(h.unexpectedReads).toHaveLength(0);
    } finally {
      await h.finish();
    }
  });
}

test('all current failures support deliberate recovery; pending clear, replacement and unmount retire late results', async () => {
  const h = await harness('ja');
  const { m, o, calls, user, window, within } = h;
  try {
    const failures: Exclude<PresentationPreview, { ok: true }>[] = [
      { ok: false, reason: 'invalid' },
      { ok: false, reason: 'denied' },
      { ok: false, reason: 'missing' },
      { ok: false, reason: 'unavailable' },
      { ok: false, reason: 'changed' },
      { ok: false, reason: 'redirect', handle: 'published-reader-with-long-name' },
    ];
    const messages = {
      invalid: m.presentation_preview_invalid,
      denied: m.presentation_preview_denied,
      missing: m.presentation_preview_missing,
      unavailable: m.presentation_preview_unavailable,
      changed: m.presentation_preview_changed,
      redirect: m.presentation_preview_redirect,
    };
    for (const failure of failures) {
      const count = calls.length;
      await h.render(failure, true);
      const [left, right] = h.panels() as [HTMLElement, HTMLElement];
      const rightPage = right.querySelector('[data-slot="published-presentation-preview"]');
      const alert = within(left).getByRole('alert');
      expect(alert.textContent).toContain(messages[failure.reason]({}, o));
      expect(left.querySelector('[data-slot="published-presentation-preview"]')).toBeNull();
      expect(calls).toHaveLength(count);
      if (failure.reason === 'redirect') {
        const link = within(left).getByRole('link', { name: `@${failure.handle}` });
        expect(link.getAttribute('href')).toBe(`/ja/@${failure.handle}`);
        expect(link.className).toContain('min-h-11');
        expect(link.className).toContain('focus-visible:outline-ring');
        expect(link.firstElementChild!.className).toContain('break-all');
        await act(async () => link.focus());
        expect(window.document.activeElement).toBe(link);
      } else expect(within(left).queryByRole('link')).toBeNull();
      await h.edit(left, m.presentation_preview_address({}, o), subject);
      await h.click(left, m.presentation_preview_inspect({}, o));
      expect(calls).toHaveLength(count + 1);
      expect(calls[count]!.input).toEqual({ target: { subject }, locale: 'ja' });
      expect(within(left).queryByRole('alert')).toBeNull();
      await act(async () => calls[count]!.pending.resolve(published('ja')));
      expect(left.textContent).toContain(m.presentation_editor_preview_current({}, o));
      expect(right.querySelector('[data-slot="published-presentation-preview"]')).toBe(rightPage);
    }

    const [left, right] = h.panels() as [HTMLElement, HTMLElement];
    const start = calls.length;
    await h.click(left, m.presentation_preview_inspect({}, o));
    await h.click(left, m.presentation_preview_close({}, o));
    expect(left.querySelector('form')!.getAttribute('aria-busy')).toBe('false');
    await act(async () => calls[start]!.pending.reject(new TypeError('retired read')));
    expect(within(left).queryByRole('alert')).toBeNull();
    expect(left.querySelector('[data-slot="published-presentation-preview"]')).toBeNull();
    await h.click(left, m.presentation_preview_inspect({}, o));
    await h.edit(left, m.presentation_preview_address({}, o), '');
    await h.edit(left, m.presentation_preview_address({}, o), subject);
    await act(async () => calls[start + 1]!.pending.resolve(published('ja', '/obsolete-input')));
    expect(left.querySelector('[data-slot="published-presentation-preview"]')).toBeNull();
    await h.click(left, m.presentation_preview_inspect({}, o));
    await act(async () => calls[start + 2]!.pending.reject(new TypeError('current read')));
    expect(within(left).getByRole('alert').textContent).toContain(m.presentation_preview_unavailable({}, o));
    expect(left.querySelector('[data-slot="published-presentation-preview"]')).toBeNull();

    await h.click(left, m.presentation_preview_inspect({}, o));
    await act(async () => calls[start + 3]!.pending.resolve(published('ja')));
    expect(within(left).queryByRole('alert')).toBeNull();
    expect(left.textContent).toContain(m.presentation_editor_preview_current({}, o));
    await h.click(left, m.presentation_preview_inspect({}, o));
    const rightAddress = h.control(right, m.presentation_preview_address({}, o));
    const rightId = rightAddress.id;
    await h.render(null);
    await act(async () => rightAddress.focus());
    const retained = right.innerHTML;
    await act(async () => calls[start + 4]!.pending.resolve(published('ja', '/late-unmounted')));
    expect(h.panels()).toEqual([right]);
    expect(right.innerHTML).toBe(retained);
    expect(window.document.activeElement).toBe(rightAddress);
    await h.render(published('ja'), true);
    expect(h.control(h.panels()[0]!, m.presentation_preview_address({}, o)).id).not.toBe(rightId);
    expect(h.control(right, m.presentation_preview_address({}, o)).id).toBe(rightId);
    // The other form can still submit and close independently after its peer retires.
    await act(async () => {
      rightAddress.focus();
      await user.keyboard('{Enter}');
    });
    expect(calls[start + 5]!.panel).toBe('right');
    expect(calls[start + 5]!.input).toEqual({ target: { route: longRoute }, locale: 'ja' });
    await h.click(right, m.presentation_preview_close({}, o));
    await act(async () => calls[start + 5]!.pending.resolve({ ok: false, reason: 'denied' }));
    expect(within(right).queryByRole('alert')).toBeNull();
    expect(h.panels()[0]!.querySelector('[data-slot="published-presentation-preview"]')).not.toBeNull();
    expect(calls).toHaveLength(start + 6);
    expect(h.unexpectedReads).toHaveLength(0);
  } finally {
    await h.finish();
  }
});
