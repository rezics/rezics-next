import { expect, mock, test } from 'bun:test';
import { act, createElement as h } from 'react';
import { dirname } from 'node:path';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import definitions from '../../../packages/definitions/release/rezics.json';
import type { GuideRelease } from '../src/features/catalogue/definition-guide';
import { qualifiedRelationsPage } from '../src/kernel/fake/qualified-relations';
import type {
  ConnectionAddress,
  ConnectionVisit,
  ConnectionStream,
  ConnectionWork,
} from '../src/features/pages/subject-connections';
import { connectionReturnWindow, subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';
mock.module('cloudflare:workers', () => ({ env: {} }));
const { readConnectionVisit } = await import('../src/features/pages/subject-connections');
const { characterWorkRows } = await import('../src/features/catalogue/character-work-visit/model');
const { OverviewContext } = await import('../src/features/pages/overview');
const { SubjectConnections } = await import('../src/features/pages/subject-connections-view');
const { subjectBody } = await import('../src/features/pages/subject');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const release = { ...definitions, digest: `sha256:${'a'.repeat(64)}` } as unknown as GuideRelease;
const snak = (property: string, content: string, data_type = 'wikibase-item') => ({
  property: { id: property, data_type },
  value: { type: 'value', content },
});
const summary = (n: number, text: string) => ({
  id: id(n),
  type: 'schema:Book',
  types: ['schema:Book'],
  label: { value: text, language: 'ja' },
  cover: null,
});
const stream = (voice = false): ConnectionStream => ({
  key: voice ? 'in:wdt:P725:qualified' : 'in:schema:character',
  property: voice ? 'wdt:P725' : 'schema:character',
  direction: 'in',
  group: voice ? 'credits' : 'characters',
  label: voice ? 'Voice performances' : 'Work appearances',
  forwardLabel: voice ? 'Voice actor' : 'Character',
  language: 'en',
  ...(voice ? { filter: id(1) } : {}),
});
function row(n = 10, voice = false) {
  return {
    subject: id(2),
    statement: id(n),
    property: stream(voice).property,
    summary: summary(2, '海の物語／作品長標題'),
    assertion: {
      ...snak(stream(voice).property, voice ? id(4) : id(1)),
      id: id(n),
      rank: 'normal',
      qualifiers: [snak(voice ? 'schema:character' : 'wdt:P3831', voice ? id(1) : id(3))],
      references: [{ parts: [snak('schema:url', `https://source.test/assertion-${n}`, 'url')] }],
      rezics: { release: release.digest, revision: 1 },
    },
    related: { [id(3)]: summary(3, 'Released protagonist role'), [id(4)]: summary(4, 'Disclosed performer') },
  };
}
function page() {
  const result = qualifiedRelationsPage();
  const reading = subjectBody(result)!;
  result.subject = id(1);
  Object.assign(reading.subject, { id: id(1), type: 'wd:Q95074' });
  result.document = { root: { props: {} }, content: [{ type: 'SubjectHeader', props: { id: 'identity' } }] };
  const plan = planReads(platformRegistry, result.document as CompositionDocument, {
    subject: id(1),
    context: result.context,
  });
  result.reads = Object.fromEntries(Object.keys(plan.reads).map((key) => [key, { status: 200, body: reading }]));
  return result;
}
function visit(cursor?: string, failed = false): Extract<ConnectionVisit, { ok: true }> {
  return {
    ok: true,
    id: id(1),
    release: release.digest,
    streams: [stream(), stream(true)],
    sections: {
      characters: {
        stream: stream(),
        reading: 'b'.repeat(64),
        section: {
          ok: true,
          read: { kind: 'links', id: id(1), property: 'schema:character', limit: 12, ...(cursor ? { cursor } : {}) },
          body: {
            links: cursor ? [row(11)] : [row(), { ...row(11), assertion: undefined }, { ...row(12), summary: null }],
            next: cursor ? null : 'native-next',
          },
        },
      },
      credits: {
        stream: stream(true),
        reading: 'c'.repeat(64),
        section: failed
          ? { ok: false, status: 503 }
          : {
              ok: true,
              read: { kind: 'links', id: id(1), property: 'wdt:P725', limit: 12, filter: id(1) },
              body: { links: [row(20, true)], next: null },
            },
      },
    },
  };
}
async function mounted(
  run: (
    host: HTMLDivElement,
    render: (
      read: (a: ConnectionAddress) => Promise<ConnectionVisit>,
      source?: ReturnType<typeof page>,
      context?: string,
    ) => Promise<void>,
    client: QueryClient,
    browser: any,
  ) => Promise<void>,
) {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const browser = new Window({ url: `https://site.test/en/subjects/${id(1)}/character` });
  const globals = {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const prior = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient();
  client.setQueryData(['session'], { state: 'signed-out', csrfToken: null });
  const source = page();
  const render = async (read: (a: ConnectionAddress) => Promise<ConnectionVisit>, next = source, context?: string) => {
    const value = {
      subject: id(1),
      subjectLabel: 'Character',
      locale: 'en',
      link: (props: any) => h('a', props),
      reader: { spoilerLevel: 0, suitability: 'show' },
      labels: { cover: {}, spoilerHide: 'Hide' },
      unlabelled: 'Unlabelled',
      spoilerShow: 'Reveal',
      relations: {},
      sections: {},
      ...(context ? { context: { id: context, population: { kind: 'global' } } } : {}),
    } as any;
    await act(async () =>
      root.render(
        h(
          QueryClientProvider,
          { client },
          h(
            OverviewContext.Provider,
            { value },
            h(SubjectConnections, { page: next, viewer: { state: 'signed-out', csrfToken: null }, read }),
          ),
        ),
      ),
    );
  };
  try {
    await run(host, render, client, browser);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    for (const [key, value] of prior) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
    await browser.happyDOM.close();
  }
}

test('mounted anonymous Character keeps assertions separate, retries only credits, continues and returns to exact work/window/focus', async () =>
  mounted(async (host, render, _client, browser) => {
    const calls: ConnectionAddress[] = [];
    let fail = true;
    const read = async (a: ConnectionAddress) => {
      calls.push(a);
      const v = visit(a.selection?.characters?.cursor, fail);
      return a.only ? { ...v, sections: { [a.only]: v.sections[a.only] } } : v;
    };
    await render(read);
    expect(host.querySelectorAll('#connections')).toHaveLength(1);
    expect(host.querySelectorAll('[data-slot="character-work-visit"] [data-work-statement]')).toHaveLength(2);
    expect(host.textContent).toContain('Released protagonist role');
    expect(host.textContent).toContain('https://source.test/assertion-10');
    expect(host.textContent).not.toContain('Disclosed performer');
    expect(host.textContent).not.toContain(id(12));
    expect(host.querySelectorAll(`a[href*="statement=${id(11)}"]`)).toHaveLength(1); // unqualified original still inspectable
    const original = host.querySelector<HTMLAnchorElement>(`a[href*="statement=${id(10)}"]`)!;
    expect(original.target).toBe('_blank');
    expect(original.href).toContain(`/subjects/${id(2)}/`);
    fail = false;
    const retry = host.querySelector('[data-connections-recovery="credits"] button') as HTMLButtonElement;
    await act(async () => retry.click());
    expect(calls.at(-1)?.only).toBe('credits');
    expect(host.textContent).toContain('Disclosed performer');
    const more = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('More'))!;
    await act(async () => more.click());
    expect(calls.at(-1)?.selection?.characters?.cursor).toBe('native-next');
    const target = host.querySelector<HTMLAnchorElement>(
      `[data-work-statement="${id(11)}"] a[href*="/subjects/${id(2)}/"]`,
    )!;
    expect(target.target).not.toBe('_blank');
    const via = new URL(target.href).searchParams.get('via')!;
    expect(subjectVisitReturn(via, 'en')).toBe(via);
    expect(connectionReturnWindow(new URL(via, 'https://site.test').hash)).toMatchObject({
      stream: 'in:schema:character',
      cursor: 'native-next',
      focus: id(11),
      holder: id(2),
    });
    browser.location.href = `https://site.test${via}`;
    await render(read, page());
    expect(calls.at(-1)?.selection?.characters).toMatchObject({ cursor: 'native-next', reading: 'b'.repeat(64) });
    expect(document.activeElement?.closest('[data-work-statement]')?.getAttribute('data-work-statement')).toBe(id(11));
  }));

test('session ABA retires pending public rows; Context replacements fence late A and whole-row spoilers hide evidence', async () =>
  mounted(async (host, render, client) => {
    let settle!: (v: ConnectionVisit) => void;
    let count = 0;
    const read = async () =>
      ++count === 1
        ? new Promise<ConnectionVisit>((resolve) => {
            settle = resolve;
          })
        : visit();
    await render(read);
    await act(async () => {
      client.setQueryData(['session'], { state: 'signed-in', subject: id(8), csrfToken: 'session-b' });
      client.setQueryData(['session'], { state: 'signed-out', csrfToken: null });
    });
    await act(async () => settle(visit()));
    expect(host.querySelectorAll('article')).toHaveLength(0);
    let late!: (v: ConnectionVisit) => void;
    let reads = 0;
    const contextual = async () =>
      ++reads === 1
        ? new Promise<ConnectionVisit>((resolve) => {
            late = resolve;
          })
        : visit();
    const source = page();
    await render(contextual, source, id(6));
    await render(contextual, source, id(7));
    await render(contextual, source, id(6));
    await act(async () => late({ ok: false, status: 503 }));
    expect(host.textContent).toContain('Released protagonist role');
    const hidden = visit();
    const section = hidden.sections.characters!.section;
    if (!section.ok) throw Error('fixture');
    const spoiled = row(30);
    spoiled.assertion.qualifiers.push({
      property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
      value: { type: 'value', content: { amount: '1', unit: '1' } },
    } as any);
    section.body.links = [spoiled, { ...row(31), summary: null }];
    await render(async () => hidden, page());
    expect(host.querySelector(`[data-work-statement="${id(30)}"]`)).toBeNull();
    expect(host.innerHTML).not.toContain('assertion-30');
    expect(host.innerHTML).not.toContain(id(31));
  }));

test('adapter64/512/4096 charges typed calls, retained native rows and UTF-8 bytes for the same Character window', async () => {
  const samples: ConnectionWork[] = [];
  for (const population of [64, 512, 4096]) {
    const catalogue = new Map(Array.from({ length: population }, (_, n) => [id(n + 100), { obsolete: n }]));
    const requests: URL[] = [];
    const body = { links: [row(), row(11)], next: 'opaque-next' };
    const client = createKernelClient('https://kernel.test', {
      fetch: (async (input, init) => {
        const url = new URL(new Request(input, init).url);
        requests.push(url);
        return Response.json(body);
      }) as typeof fetch,
    });
    const address = {
      id: id(1),
      locale: 'en',
      only: 'characters' as const,
      selection: { characters: { stream: stream().key, cursor: 'native-window' } },
    };
    const result = await readConnectionVisit(client, address, undefined, undefined, {
      page: async () => ({ kind: 'page', page: page() }) as any,
      release: async () => release,
      observe: (w) => samples.push({ ...w }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error('fixture');
    expect(characterWorkRows(result.sections.characters!, id(1), 'en', 0)).toHaveLength(2);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.searchParams.get('cursor')).toBe('native-window');
    expect(catalogue.size).toBe(population); // Unrelated and obsolete data never enters this consumer.
    expect(samples.at(-1)).toEqual({
      calls: 5,
      values: 2,
      bytes: new TextEncoder().encode(JSON.stringify(body)).byteLength,
    });
  }
  expect(samples).toEqual(Array(3).fill(samples[0])); // Adapter evidence only; no native SQL claim.
});
