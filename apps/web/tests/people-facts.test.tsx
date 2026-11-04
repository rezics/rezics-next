import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import definitions from '../src/kernel/recorded/definitions-release.json';
import { peopleFactsExample } from '../src/features/catalogue/people-facts/examples';
import { admitFacts, factVisitBounds } from '../src/features/catalogue/people-facts/model';
import { readValueExplanation, type ValueRead, type ValueRequest } from '../src/features/catalogue/value-explanation';

let read: (request: ValueRequest) => Promise<ValueRead> = async () => ({ kind: 'unavailable' });
const requests: ValueRequest[] = [];
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('../src/features/catalogue/value-explanation-actions', () => ({
  loadValueExplanation: ({ data }: { data: ValueRequest }) => {
    requests.push(data);
    return read(data);
  },
}));
const { PersonReader } = await import('../src/features/catalogue/person-reader/reader');
const { CharacterReader } = await import('../src/features/pages/showcase-people/character');
const { m } = await import('../src/paraglide/messages.js');

async function mounted(character = false) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(require.resolve('happy-dom', { paths: [require.resolve('@puckeditor/core')] }));
  const window = new Window({ url: 'https://site.test/en/profile' });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'MutationObserver',
    'getComputedStyle',
    'IS_REACT_ACT_ENVIRONMENT',
  ];
  const previous = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key],
    });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], { state: 'signed-out', csrfToken: null, subject: null });
  const fixture = peopleFactsExample(character);
  let reading = { public: fixture.read, release: fixture.release, documents: fixture.documents, locale: 'en' };
  const draw = () =>
    act(async () => {
      root.render(h(QueryClientProvider, { client }, h(character ? CharacterReader : PersonReader, reading)));
    });
  const click = (element: Element) =>
    act(async () => {
      element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 0 }));
    });
  const button = (text: string, within: ParentNode = host) =>
    Array.from(within.querySelectorAll('button')).find((element) => element.textContent === text)!;
  await draw();
  return {
    host,
    window,
    fixture,
    client,
    draw,
    click,
    button,
    replace(publicRead = structuredClone(fixture.read)) {
      reading = { ...reading, public: publicRead };
    },
    async close() {
      await act(async () => root.unmount());
      client.clear();
      window.happyDOM.abort();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('Person and Character windows preserve duplicate assertions, evidence and keyboard position without native reads', async () => {
  for (const character of [false, true]) {
    const page = await mounted(character);
    try {
      const { host, fixture, click, button, window } = page;
      requests.length = 0;
      const field = host.querySelector(`[id="profile-fact-${encodeURIComponent(fixture.property)}"]`)!.parentElement!;
      expect(field.querySelectorAll('li[data-statement]')).toHaveLength(20);
      expect(field.textContent).toContain('Condition 2');
      expect(field.textContent).toContain('最初 العربية');
      expect(field.textContent).toContain('https://example.org/biography');
      await click(button(m.people_facts_browse(), field));
      await click(button(m.people_facts_next(), field));
      expect(field.textContent).toContain('Condition 21');
      expect(field.textContent).not.toContain('Condition 43');
      const input = field.querySelector('input')!;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input, 'no such visible value');
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
      expect(field.textContent).toContain(m.people_facts_empty());
      await click(button(m.people_facts_reset(), field));
      expect(field.querySelectorAll('li[hidden]')).toHaveLength(0);
      expect(requests).toHaveLength(0);
      let address: ValueRequest | undefined;
      read = async (request) => {
        address = request;
        return { kind: 'denied' };
      };
      const origin = field.querySelector('a[href*="/value?"]') as HTMLAnchorElement;
      origin.focus();
      const modified = new window.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true, button: 0 });
      await act(async () => {
        origin.dispatchEvent(modified);
      });
      expect(modified.defaultPrevented).toBe(false);
      expect(requests).toHaveLength(0);
      await click(origin);
      expect(address).toMatchObject({
        id: fixture.read.subject.id,
        property: fixture.property,
        statement: fixture.rows[20]!.id,
        context: fixture.read.subject.context,
        locale: 'en',
        expectedReader: null,
      });
      expect(host.querySelectorAll('[data-slot="people-fact-visit"]')).toHaveLength(1);
      expect(host.querySelector('h1')).toBeNull();
      expect(host.textContent).toContain(m.value_denied());
      expect(window.document.activeElement?.getAttribute('data-slot')).toBe('people-fact-visit');
      await act(async () => {
        window.document.activeElement!.dispatchEvent(
          new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
      expect(window.document.activeElement).toBe(origin);
      expect(field.textContent).toContain('Condition 21');
      expect(field.querySelector('input')?.value).toBe('');
    } finally {
      await page.close();
    }
  }
});

test('exact currentness loss returns to the field; held results cannot survive source A-B-A or browser replacement', async () => {
  const page = await mounted();
  try {
    const { host, fixture, click, window } = page;
    read = async () => ({
      kind: 'ready',
      page: {
        id: fixture.read.subject.id,
        title: { text: 'Person', lang: undefined },
        typeLabel: { text: 'Person', lang: undefined },
        propertyLabel: { text: 'Occupation', lang: undefined },
        href: '/en/profile',
        context: fixture.read.subject.context,
        related: {},
        labels: {},
        absence: 'not-selected',
      },
    });
    const field = host.querySelector(`[id="profile-fact-${encodeURIComponent(fixture.property)}"]`)!.parentElement!;
    await click(field.querySelector('a[href*="/value?"]')!);
    expect(host.textContent).toContain(m.value_not_selected());
    expect(field.textContent).toContain(m.people_facts_changed());
    await click(page.button(m.people_facts_return()));
    expect(window.document.activeElement?.id).toBe(`profile-fact-${encodeURIComponent(fixture.property)}`);
    let finish: ((value: ValueRead) => void) | undefined;
    read = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    await click(field.querySelector('a[href*="/value?"]')!);
    const heldReturn = page.button(m.people_facts_return());
    page.replace();
    await page.draw();
    page.replace(fixture.read);
    await page.draw();
    await act(async () => finish!({ kind: 'denied' }));
    await click(heldReturn);
    expect(host.querySelector('[data-slot="people-fact-visit"]')).toBeNull();
    expect(host.textContent).not.toContain(m.value_denied());
    read = async () => ({ kind: 'unavailable' });
    await click(host.querySelector('a[href*="/value?"]')!);
    expect(host.textContent).toContain(m.value_error());
    await act(async () =>
      page.client.setQueryData(['session'], {
        state: 'signed-in',
        subject: crypto.randomUUID(),
        csrfToken: 'A'.repeat(22),
      }),
    );
    expect(host.querySelector('[data-slot="people-fact-visit"]')).toBeNull();
  } finally {
    await page.close();
  }
});

test('whole admission and native-compatible composition charge actual calls and bytes at three unrelated history scales', async () => {
  const charges: unknown[] = [];
  for (const scale of [64, 512, 4096]) {
    const fixture = peopleFactsExample();
    const reading = { public: fixture.read, release: fixture.release, locale: 'en', documents: fixture.documents };
    const projection = admitFacts(reading, [fixture.property])!;
    expect(projection.fields[fixture.property]).toHaveLength(43);
    const subjects = new Map(
      Array.from({ length: scale }, (_, index) => [`unrelated-${index}`, { obsolete: 'old'.repeat(1024) }]),
    );
    const history = new Map(Array.from({ length: scale }, (_, index) => [index + 100, 'obsolete'.repeat(1024)]));
    const calls: string[] = [];
    let decoded = 0;
    const native = createKernelClient('https://people-facts.test', {
      fetch: (async (input, init) => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        const url = new URL(request.url);
        calls.push(url.pathname);
        let body: unknown = { code: 'overloaded' };
        let status = 503;
        if (url.pathname === `/v1/subjects/${fixture.read.subject.id}`) {
          body = fixture.read;
          status = 200;
        } else if (url.pathname.includes('/definitions/releases/')) {
          body = definitions;
          status = 200;
        } else if (url.pathname.endsWith('/candidates')) {
          body = { candidates: [], adoption: null, next: null };
          status = 200;
        }
        const encoded = JSON.stringify(body);
        decoded += new TextEncoder().encode(encoded).byteLength;
        return new Response(encoded, { status, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    const result = await readValueExplanation(native, {
      id: fixture.read.subject.id,
      property: fixture.property,
      statement: fixture.rows[0]!.id,
      context: fixture.read.subject.context,
      locale: 'en',
    });
    expect(result.kind === 'ready' && result.page.statement?.id).toBe(fixture.rows[0]!.id);
    expect(result.kind === 'ready' && result.page.competition?.kind).toBe('not-returned');
    expect(calls).toHaveLength(4);
    expect(subjects.size).toBe(scale);
    expect(history.size).toBe(scale);
    charges.push({
      scale,
      requests: calls.length,
      decodedBytes: decoded,
      admittedBytes: projection.bytes,
      retainedWindows: 1,
      maximumMountedRowsPerField: factVisitBounds.rows,
    });
    const overflow = structuredClone(reading);
    overflow.public.subject.statements[fixture.property]![0]!.references[0]!.parts[0]!.value = {
      type: 'value',
      content: '界'.repeat(factVisitBounds.bytes / 2),
    };
    expect(admitFacts(overflow, [fixture.property])).toBeUndefined();
  }
  const stable = charges as { decodedBytes: number; admittedBytes: number }[];
  expect(new Set(stable.map((charge) => charge.decodedBytes)).size).toBe(1);
  expect(new Set(stable.map((charge) => charge.admittedBytes)).size).toBe(1);
  console.info('Consumer fixture charges (not native examined-row proof):', JSON.stringify(charges));
});
