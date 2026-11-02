import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ScreenRead } from '../src/features/catalogue/screen-profile';

mock.module('cloudflare:workers', () => ({ env: {} }));

test('Screen refresh keeps corrections and exact uncertain requests; recovery replaces facts and concealment clears them', async () => {
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
  admitted.public.subject.statements['test:retired'] = [1, 2].map((number) => ({
    ...structuredClone(fixture.facts.date.source),
    id: `retired-${number}`,
    property: { id: 'test:retired', data_type: 'string' },
    value: { type: 'value', content: `Supplied assertion ${number}` },
    qualifiers: [{ property: { id: 'test:qualifier', data_type: 'string' }, value: { type: 'somevalue' } }],
    references: [
      { parts: [part('test:title', 'Original source title'), part('test:url', 'https://source.test/citation')] },
      { parts: [{ property: { id: 'test:unknown', data_type: 'string' }, value: { type: 'novalue' } }] },
    ],
  }));
  let next: ScreenRead | 'throw' = admitted;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const button = (name: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === name && !node.disabled,
    )!;
  const click = async (name: string) =>
    act(async () => {
      await user.click(button(name));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  const reading = () => host.querySelector('section[aria-label]')!;
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ScreenProfile
            id={fixture.id}
            locale="en"
            session="signed-in"
            search={async () => []}
            onNavigate={() => {}}
            transport={{
              ...fixture.transport,
              load: async () => {
                if (next === 'throw') throw new Error('Transient read failure');
                return next;
              },
            }}
          />
        </QueryClientProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(reading().textContent).toContain('Supplied assertion 1');
    expect(reading().textContent).toContain('Supplied assertion 2');
    expect(reading().querySelector('dt[lang="ja"]')?.textContent).toBe('出典名');
    expect(reading().textContent).toContain('test:url');
    expect(reading().textContent).toContain(m.subject_value_unknown());
    expect(reading().textContent).toContain(m.subject_value_none());
    expect(reading().querySelectorAll('a[href="https://source.test/citation"]')).toHaveLength(2);
    expect(reading().textContent).toContain(`${m.correction_references()} 2`);
    expect(host.querySelector('a[href$="/authored"]')).not.toBeNull();
    await click(m.facts_edit_field());
    const year = host.querySelector<HTMLInputElement>(`input[aria-label="${m.correction_year()}"]`)!;
    await act(async () => {
      await user.clear(year);
      await user.type(year, '2027');
    });
    await click(m.facts_submit());
    expect(host.textContent).toContain(m.facts_uncertain());
    next = { ok: false, reason: 'unavailable' };
    await click(m.candidate_reload());
    expect(host.textContent).toContain(m.screen_refresh_failed());
    expect(reading().getAttribute('aria-label')).toBe(m.screen_previous_reading());
    expect(year.isConnected && year.disabled).toBe(true);
    expect(year.value).toBe('2027');
    next = 'throw';
    await click(m.correction_retry());
    expect(year.isConnected).toBe(true);
    next = structuredClone(admitted);
    next.public!.subject.labels = { en: 'Recovered observatory' };
    delete next.public!.subject.statements['test:retired'];
    await click(m.correction_retry());
    expect(reading().getAttribute('aria-label')).toBe(m.candidate_current());
    expect(host.textContent).toContain('Recovered observatory');
    expect(host.textContent).not.toContain(m.screen_refresh_failed());
    expect(reading().textContent).not.toContain('Supplied assertion');
    expect(year.isConnected && year.disabled).toBe(true);
    await click(m.facts_submit());
    const writes = fixture.facts.date.calls.filter((call) => call.method === 'POST');
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    next = { ok: false, reason: 'concealed' };
    await click(m.candidate_reload());
    expect(year.isConnected).toBe(false);
    expect(host.querySelector('a, input, details')).toBeNull();
    expect(host.textContent).not.toContain('Recovered observatory');
    next = { ok: false, reason: 'unavailable' };
    await click(m.correction_retry());
    expect(host.querySelector('a, input, details')).toBeNull();
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
