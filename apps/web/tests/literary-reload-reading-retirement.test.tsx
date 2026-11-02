import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LiteraryRead } from '../src/features/catalogue/literary-profile';

mock.module('cloudflare:workers', () => ({ env: {} }));

async function mounted(
  run: (ui: {
    host: HTMLElement;
    render: (node: ReactNode) => Promise<void>;
    until: (check: () => boolean) => Promise<void>;
    click: (name: string, scope?: ParentNode) => Promise<void>;
    enter: (input: HTMLInputElement, value: string) => Promise<void>;
  }) => Promise<void>,
) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/subjects/book/title' });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'DocumentFragment',
    'MutationObserver',
    'ResizeObserver',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'IS_REACT_ACT_ENVIRONMENT',
  ];
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key],
    });
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const button = (scope: ParentNode, name: string) =>
    [...scope.querySelectorAll<HTMLButtonElement>('button')].findLast((node) => node.textContent?.trim() === name)!;
  try {
    await run({
      host,
      render: async (node) => act(async () => root.render(h(QueryClientProvider, { client }, node))),
      click: async (name, scope = host) => act(async () => button(scope, name).click()),
      enter: async (input, value) =>
        act(async () => {
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
          input.dispatchEvent(new window.Event('input', { bubbles: true }));
        }),
      until: async (check) => {
        for (let n = 0; n < 100 && !check(); n++)
          await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
        expect(check()).toBe(true);
      },
    });
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
}

function button(scope: ParentNode, name: string) {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === name)!;
}

function submit(form: HTMLFormElement) {
  const key = Object.keys(form).find((name) => name.startsWith('__reactProps$'))!;
  return Reflect.get(form, key).onSubmit as (event: { preventDefault: () => void }) => Promise<void>;
}

function prop(node: Element, name: string) {
  const key = Object.keys(node).find((value) => value.startsWith('__reactProps$'))!;
  return Reflect.get(node, key)[name] as ((event: { currentTarget: { open: boolean } }) => void) | undefined;
}

test('Literary reload retires the current observation through failures and equal-identity recovery', async () => {
  await mounted(async ({ host, render, until, click, enter }) => {
    const { LiteraryProfile } = await import('../src/features/catalogue/literary-profile-view');
    const { literaryFixture, literaryWorkId, literaryRelease } =
      await import('../src/kernel/fake/catalogue-literary-profile');
    const { m } = await import('../src/paraglide/messages.js');
    const fixture = literaryFixture('ready', 'en', 'schema:Book', true);
    const initial = await fixture.transport.load();
    if (!initial.ok || !initial.current) throw new Error('Expected current Literary reading');
    let mode: 'initial' | 'pending' | 'returned' | 'recovered' = 'initial';
    let loads = 0;
    let rejectPending!: (error: Error) => void;
    const startsRetired: boolean[] = [];
    const retired = () =>
      !host.textContent?.includes('An original literary work') &&
      !host.querySelector('a[href*="/subjects/"]') &&
      !host.querySelector('section[aria-label="word count"]');
    const recovered: LiteraryRead = structuredClone(initial);
    if (recovered.ok && recovered.current) recovered.current.public.subject.labels = { en: 'Fresh Literary title' };
    const commands: Parameters<typeof fixture.facts.propose>[0][] = [];
    let relationMounts = 0;
    function RelationProbe() {
      relationMounts++;
      return h('p', { 'data-relation-probe': true }, 'Private relation editor');
    }
    await render(
      h(LiteraryProfile, {
        id: literaryWorkId,
        locale: 'en',
        session: 'signed-in',
        transport: {
          ...fixture.transport,
          load: () => {
            loads++;
            if (loads === 1) return Promise.resolve(initial);
            startsRetired.push(retired());
            if (mode === 'pending')
              return new Promise<LiteraryRead>((_resolve, reject) => {
                rejectPending = reject;
              });
            if (mode === 'returned') return Promise.resolve({ ok: false, reason: 'denied' });
            return Promise.resolve(recovered);
          },
        },
        facts: {
          ...fixture.facts,
          propose: async (command: Parameters<typeof fixture.facts.propose>[0]) => {
            commands.push(command);
            return { ok: false, reason: 'uncertain' };
          },
        },
        review: fixture.review,
        relations: h(RelationProbe),
        authored: h(RelationProbe),
      }),
    );
    await until(() => host.textContent!.includes('An original literary work'));
    const field = () => host.querySelector<HTMLElement>('section[aria-label="word count"]')!;
    await click(m.facts_edit_field(), field());
    await enter(field().querySelector<HTMLInputElement>(`input[aria-label="${m.correction_amount()}"]`)!, '+13000');
    expect(field().querySelector('[data-slot="checkbox"]')?.getAttribute('aria-checked')).toBe('true');
    await click(m.facts_submit());
    await until(() => commands.length === 1 && host.textContent!.includes(m.facts_uncertain()));
    expect(JSON.stringify(commands[0])).toContain('https://example.org/bibliography');
    const staleSubmit = submit(host.querySelector('form')!);
    const oldToggle = [...host.querySelectorAll('details')].map((node) => prop(node, 'onToggle')).find(Boolean)!;
    expect(oldToggle).toBeDefined();

    mode = 'pending';
    await click(m.correction_reload());
    await until(() => loads === 2);
    expect(startsRetired[0]).toBe(true);
    expect(retired()).toBe(true);
    await act(async () => staleSubmit({ preventDefault() {} }));
    expect(commands).toHaveLength(1);
    await act(async () => rejectPending(new Error('refresh failed')));
    await until(() => !!host.querySelector('[role="alert"]'));
    expect(retired()).toBe(true);

    mode = 'returned';
    await click(m.correction_reload());
    await until(() => loads === 3 && !!host.querySelector('[role="alert"]'));
    expect(startsRetired[1]).toBe(true);
    expect(retired()).toBe(true);

    mode = 'recovered';
    await click(m.correction_reload());
    expect(startsRetired[2]).toBe(true);
    await until(() => host.textContent!.includes('Fresh Literary title'));
    expect(field()).toBeDefined();
    expect(host.textContent).toContain('Fresh Literary title');
    await act(async () => staleSubmit({ preventDefault() {} }));
    await act(async () => oldToggle({ currentTarget: { open: true } }));
    expect(commands).toHaveLength(1);
    expect(relationMounts).toBe(0);

    const nameLabel = literaryRelease.properties['schema:name']!.labels.en;
    const nameField = host.querySelector<HTMLElement>(`section[aria-label="${nameLabel}"]`)!;
    await click(m.facts_edit_field(), nameField);
    await enter(
      nameField.querySelector<HTMLInputElement>(`input[aria-label="${m.correction_value()}"]`)!,
      'A new name',
    );
    await click(m.facts_submit());
    await until(() => commands.length === 3);
    expect(commands[1]).toBe(commands[0]);
    expect(commands[2]!.statement.property.id).toBe('schema:name');
  });
});
