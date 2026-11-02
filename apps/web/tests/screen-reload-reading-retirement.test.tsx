import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { EditorRead } from '../src/features/catalogue/statement-editor';
import type { ScreenRead } from '../src/features/catalogue/screen-profile';

mock.module('cloudflare:workers', () => ({ env: {} }));

test('Screen refresh keeps corrections and exact uncertain requests; refusal retires markup and recovery admits only matching current reads', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en' });
  const keys =
    'window document navigator HTMLElement HTMLInputElement Element Node DocumentFragment MutationObserver ResizeObserver getComputedStyle requestAnimationFrame cancelAnimationFrame IS_REACT_ACT_ENVIRONMENT'.split(
      ' ',
    );
  const saved = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key],
    });
  const { createRoot } = await import('react-dom/client');
  const { default: userEvent } = await import(
    createRequire(require.resolve('storybook/test')).resolve('@testing-library/user-event')
  );
  const user = userEvent.setup({ document: window.document });
  const { ScreenProfile } = await import('../src/features/catalogue/screen-profile-view');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { screenProfileFixture } = await import('../src/kernel/fake/catalogue-screen-profile');
  const { m } = await import('../src/paraglide/messages.js');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const fixture = screenProfileFixture('uncertain', 'en', true);
  const admitted = await fixture.transport.load();
  if (!admitted.ok || !admitted.public) throw new Error('Expected Screen reading');
  const part = (id: string, content: string) => ({
    property: { id, data_type: id === 'test:url' ? 'url' : 'string' },
    value: { type: 'value' as const, content },
  });
  admitted.public.related['test:title'] = { labels: { ja: '出典名' } };
  admitted.public.subject.statements['test:retired'] = [
    {
      ...structuredClone(fixture.facts.date.source),
      ...part('test:retired', 'Supplied assertion'),
      references: [
        { parts: [part('test:title', 'Original source title'), part('test:url', 'https://source.test/citation')] },
        { parts: [part('test:page', '42')] },
      ],
    },
  ];
  let next: ScreenRead | 'throw' = admitted;
  let pending: Promise<ScreenRead> | undefined;
  const scalar: EditorRead = { ok: false, reason: 'denied' };
  let scalarRead: () => Promise<EditorRead> = async () => scalar;
  let page = fixture.id;
  let reader = { state: 'signed-in' as const, subject: 'reader-a', csrfToken: 'csrf-a' };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const button = (name: string, region: Element = host) =>
    [...region.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === name && !node.disabled,
    )!;
  const click = async (name: string, region: Element = host) =>
    act(async () => {
      await user.click(button(name, region));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  const reading = () => host.querySelector('section[aria-label]')!;
  const mount = async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <CandidateReaderBoundary observed={reader} address={page}>
            <ScreenProfile
              id={page}
              locale="en"
              session="signed-in"
              search={async () => []}
              onNavigate={() => {}}
              transport={{
                ...fixture.transport,
                facts: { ...fixture.facts.transport, read: () => scalarRead() },
                load: async () => {
                  if (pending) return pending;
                  if (next === 'throw') throw new Error('Transient read failure');
                  return next;
                },
              }}
            />
          </CandidateReaderBoundary>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };
  const retired = () => {
    expect(host.querySelector('a, input, summary, section[aria-label]')).toBeNull();
    for (const text of [
      'The observatory',
      'Supplied assertion',
      'Original source title',
      'https://source.test/citation',
      'Recovered observatory',
    ])
      expect(host.innerHTML).not.toContain(text);
  };
  try {
    await mount();
    expect(reading().textContent).toContain('Supplied assertion');
    expect(reading().querySelector('dt[lang="ja"]')?.textContent).toBe('出典名');
    expect(reading().textContent).toContain('test:url');
    expect(reading().querySelectorAll('a[href="https://source.test/citation"]')).toHaveLength(1);
    expect(reading().textContent).toContain(`${m.correction_references()} 2`);
    expect(host.querySelector('a[href$="/authored"]')).not.toBeNull();
    const date = admitted.release.properties['schema:datePublished']!.labels.en;
    await click(m.facts_edit_field(), host.querySelector(`section[aria-label="${date}"]`)!);
    const year = host.querySelector<HTMLInputElement>(`input[aria-label="${m.correction_year()}"]`)!;
    await act(async () => {
      await user.clear(year);
      await user.type(year, '2027');
    });
    await click(m.facts_submit());
    expect(year.closest('fieldset[disabled]')).not.toBeNull();
    let finishRefresh!: (read: ScreenRead) => void;
    pending = new Promise((resolve) => {
      finishRefresh = resolve;
    });
    await click(m.candidate_reload());
    retired();
    finishRefresh({ ok: false, reason: 'unavailable' });
    pending = undefined;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(host.textContent).toContain(m.screen_refresh_failed());
    retired();
    expect(year.isConnected).toBe(false);
    next = structuredClone(admitted);
    next.public!.subject.labels = { en: 'Recovered observatory' };
    delete next.public!.subject.statements['test:retired'];
    await click(m.correction_retry());
    expect(reading().getAttribute('aria-label')).toBe(m.candidate_current());
    expect(host.textContent).toContain('Recovered observatory');
    expect(host.textContent).not.toContain(m.screen_refresh_failed());
    expect(reading().textContent).not.toContain('Supplied assertion');
    next = 'throw';
    await click(m.candidate_reload());
    retired();
    next = structuredClone(admitted);
    await click(m.correction_retry());
    const recovered = host.querySelector<HTMLInputElement>(`input[aria-label="${m.correction_year()}"]`)!;
    expect(recovered.value).toBe('2027');
    expect(recovered.closest('fieldset[disabled]')).not.toBeNull();
    expect(fixture.facts.date.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    await click(m.facts_submit());
    const writes = fixture.facts.date.calls.filter((call) => call.method === 'POST');
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    let finishScalar!: (read: EditorRead) => void;
    let scalarReadStarted = false;
    scalarRead = () => {
      scalarReadStarted = true;
      return new Promise((resolve) => {
        finishScalar = resolve;
      });
    };
    await click(m.correction_reload());
    expect(scalarReadStarted).toBe(true);
    next = structuredClone(admitted);
    next.public!.subject.labels = { en: 'Recovered observatory' };
    await click(m.candidate_reload());
    expect(reading().textContent).toContain('Recovered observatory');
    const staleScalar: EditorRead = {
      ok: true,
      release: admitted.release,
      public: { ...structuredClone(admitted.public.subject), labels: { en: 'Stale scalar reading' } },
      source: null,
    };
    finishScalar(staleScalar);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(reading().textContent).toContain('Recovered observatory');
    expect(host.textContent).not.toContain('Stale scalar reading');
    scalarRead = async () => scalar;
    next = { ok: false, reason: 'concealed' };
    await click(m.candidate_reload());
    expect(year.isConnected).toBe(false);
    retired();
    expect(host.textContent).not.toContain('Recovered observatory');
    next = { ok: false, reason: 'unavailable' };
    await click(m.correction_retry());
    retired();
    next = structuredClone(admitted);
    next.public!.subject.id = 'other-screen';
    await click(m.correction_retry());
    retired();
    next = structuredClone(admitted);
    await click(m.correction_retry());
    expect(reading().textContent).toContain('Supplied assertion');
    expect(fixture.facts.date.calls.filter((call) => call.method === 'POST')).toHaveLength(2);
    await click(m.correction_reload());
    retired();
    await click(m.correction_retry());
    expect(reading().textContent).toContain('Supplied assertion');
    for (const change of ['page', 'viewer', 'csrf']) {
      let finish!: (read: ScreenRead) => void;
      pending = new Promise((resolve) => {
        finish = resolve;
      });
      await click(m.candidate_reload());
      if (change === 'page') page = 'another-screen';
      else reader = { ...reader, [change === 'viewer' ? 'subject' : 'csrfToken']: change };
      pending = undefined;
      next = structuredClone(admitted);
      next.public!.subject.id = page;
      next.public!.subject.labels = { en: `Fresh ${change}` };
      await mount();
      await act(async () => {
        finish(admitted);
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(host.textContent).toContain(`Fresh ${change}`);
      expect(host.textContent).not.toContain('The observatory');
      expect(host.querySelector(`input[aria-label="${m.correction_year()}"]`)).toBeNull();
    }
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
