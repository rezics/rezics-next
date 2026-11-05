import { expect, mock, test } from 'bun:test';
import { act, createElement as h } from 'react';
import { dirname } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import definitions from '../../../packages/definitions/release/rezics.json';
import type { GuideRelease } from '../src/features/catalogue/definition-guide';
import { qualifiedRelationsPage } from '../src/kernel/fake/qualified-relations';
import type {
  ConnectionAddress,
  ConnectionSection,
  ConnectionStream,
  ConnectionVisit,
} from '../src/features/pages/subject-connections';
import type { ConnectionRead } from '../src/features/pages/subject-connections-window';
import { connectionReturnWindow, subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { OverviewContext } = await import('../src/features/pages/overview');
const { SubjectConnections } = await import('../src/features/pages/subject-connections-view');
const { subjectBody } = await import('../src/features/pages/subject');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const release = { ...definitions, digest: `sha256:${'a'.repeat(64)}` } as unknown as GuideRelease;
const page = () => {
  const result = qualifiedRelationsPage();
  const reading = subjectBody(result)!;
  result.subject = id(1);
  Object.assign(reading.subject, { id: id(1), type: 'wd:Q95074' });
  result.document = { root: { props: {} }, content: [{ type: 'SubjectHeader', props: { id: 'identity' } }] };
  const plan = planReads(platformRegistry, result.document as CompositionDocument, { subject: id(1) });
  result.reads = Object.fromEntries(Object.keys(plan.reads).map((key) => [key, { status: 200, body: reading }]));
  return result;
};
const appearance: ConnectionStream = {
  key: 'in:schema:character',
  property: 'schema:character',
  direction: 'in',
  group: 'characters',
  label: 'Work appearances',
  forwardLabel: 'Character',
  language: 'en',
};
const voice: ConnectionStream = {
  key: 'in:wdt:P725:qualified',
  property: 'wdt:P725',
  direction: 'in',
  group: 'credits',
  label: 'Voice performances',
  forwardLabel: 'Voice actor',
  language: 'en',
  filter: id(1),
};
const otherCredit: ConnectionStream = {
  key: 'out:wdt:P286',
  property: 'wdt:P286',
  direction: 'out',
  group: 'credits',
  label: 'Crew',
  forwardLabel: 'Crew',
  language: 'en',
};
const relation: ConnectionStream = {
  key: 'out:wdt:P144',
  property: 'wdt:P144',
  direction: 'out',
  group: 'relations',
  label: 'Part of',
  forwardLabel: 'Part of',
  language: 'en',
};
const snak = (property: string, content: unknown, dataType = 'wikibase-item') => ({
  property: { id: property, data_type: dataType },
  value: { type: 'value', content },
});
const summary = (n: number, label: string) => ({
  id: id(n),
  type: 'schema:Book',
  types: ['schema:Book'],
  label: { value: label, language: 'en' },
  cover: null,
});
function appearanceRow(statement: number, spoiler = false, title = `Work ${statement}`) {
  return {
    subject: id(2),
    statement: id(statement),
    property: appearance.property,
    summary: summary(2, title),
    assertion: {
      ...snak(appearance.property, id(1)),
      id: id(statement),
      rank: 'normal',
      qualifiers: [
        snak('wdt:P3831', id(3)),
        ...(spoiler ? [snak('rezics:spoilerLevel', { amount: '1', unit: '1' }, 'quantity')] : []),
      ],
      references: [{ parts: [snak('schema:url', `https://source.test/assertion-${statement}`, 'url')] }],
      rezics: { release: release.digest, revision: 1 },
    },
    related: { [id(3)]: summary(3, 'Released role') },
  };
}
function section(
  stream: ConnectionStream,
  cursor: string | undefined,
  links: unknown[],
  next?: string,
  status?: number,
  pageReading = 'a',
) {
  return {
    stream,
    ...(!status ? { reading: pageReading.repeat(64) } : {}),
    section: status
      ? { ok: false as const, status }
      : {
          ok: true as const,
          read: {
            kind: stream.direction === 'in' ? ('links' as const) : ('relations' as const),
            id: id(1),
            property: stream.property,
            limit: 12,
            ...(cursor ? { cursor } : {}),
          },
          body: { [stream.direction === 'in' ? 'links' : 'relations']: links, ...(next ? { next } : {}) },
        },
  } as ConnectionSection;
}
function visit(
  address: ConnectionAddress,
  options: { failPrevious?: boolean; spoiler?: boolean; privateTitle?: string } = {},
): ConnectionVisit {
  const charCursor = address.selection?.characters?.cursor;
  const charPage = charCursor === 'appearance-page-2' ? 2 : charCursor === 'appearance-page-3' ? 3 : 1;
  const charStream =
    [appearance, voice, otherCredit, relation].find(
      (stream) => stream.key === address.selection?.[stream.group]?.stream,
    ) ?? appearance;
  const creditStream =
    [voice, otherCredit].find((stream) => stream.key === address.selection?.credits?.stream) ?? voice;
  const fail = options.failPrevious && address.selection?.characters?.reading === 'a'.repeat(64);
  const sections: Partial<Record<'relations' | 'characters' | 'credits', ConnectionSection>> = {
    relations: section(relation, undefined, []),
    characters: fail
      ? section(appearance, undefined, [], undefined, 403)
      : section(
          appearance,
          charCursor,
          charPage === 3 ? [] : [appearanceRow(charPage === 1 ? 10 : 11, options.spoiler, options.privateTitle)],
          charPage < 3 ? `appearance-page-${charPage + 1}` : undefined,
          undefined,
          charPage === 1 ? 'a' : charPage === 2 ? 'b' : 'c',
        ),
    credits:
      creditStream === otherCredit
        ? section(otherCredit, undefined, [])
        : section(voice, undefined, [appearanceRow(20)]),
  };
  if (address.only) {
    const group = address.only;
    return {
      ok: true,
      id: id(1),
      release: 'release',
      streams: [appearance, voice, otherCredit, relation],
      sections: { [group]: sections[group] },
    };
  }
  // A caller can switch streams only within its own selected group.
  if (address.selection?.characters?.stream && address.selection.characters.stream !== appearance.key)
    sections.characters = section(charStream, undefined, []);
  return { ok: true, id: id(1), release: 'release', streams: [appearance, voice, otherCredit, relation], sections };
}

async function mounted(
  run: (
    host: HTMLDivElement,
    render: (read: ConnectionRead, source?: ReturnType<typeof page>, context?: string) => Promise<void>,
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
  const render = async (read: ConnectionRead, next = source, context?: string) => {
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
function button(section: Element, name: string) {
  return Array.from(section.querySelectorAll('button')).find((item) =>
    item.textContent?.includes(name),
  ) as HTMLButtonElement;
}

test('mounted pages go forward, back through an empty terminal, and return to the exact retained assertion and focus', async () =>
  mounted(async (host, render, _client, browser) => {
    const calls: ConnectionAddress[] = [];
    const read: ConnectionRead = async (address) => {
      calls.push(address);
      return visit(address);
    };
    await render(read);
    const characters = () => host.querySelector('[aria-labelledby="connections-characters"]')!;
    expect(characters().querySelector(`[data-work-statement="${id(10)}"]`)).toBeTruthy();
    await act(async () => button(characters(), 'Next page').click());
    expect(calls.at(-1)?.selection?.characters?.cursor).toBe('appearance-page-2');
    expect(characters().textContent).toContain('Page 2');
    expect(characters().querySelector(`[data-work-statement="${id(11)}"]`)).toBeTruthy();
    await act(async () => button(characters(), 'Next page').click());
    expect(characters().textContent).toContain('Page 3');
    expect(characters().textContent).toContain('No visible entries on this page.');
    await act(async () => button(characters(), 'Previous page').click());
    expect(calls.at(-1)?.selection?.characters).toMatchObject({ cursor: 'appearance-page-2', reading: 'b'.repeat(64) });
    const work = characters().querySelector<HTMLAnchorElement>(
      `[data-work-statement="${id(11)}"] a[href*="/subjects/${id(2)}/"]`,
    )!;
    const via = new URL(work.href).searchParams.get('via')!;
    expect(subjectVisitReturn(via, 'en')).toBe(via);
    expect(connectionReturnWindow(new URL(via, 'https://site.test').hash)).toMatchObject({
      stream: appearance.key,
      index: 1,
      history: [{ page: 1 }, { page: 2 }, { page: 3 }],
      focus: id(11),
      holder: id(2),
    });
    browser.location.href = `https://site.test${via}`;
    await render(read, page());
    expect(calls.at(-1)?.selection?.characters).toMatchObject({ cursor: 'appearance-page-2', reading: 'b'.repeat(64) });
    expect(document.activeElement?.closest('[data-work-statement]')?.getAttribute('data-work-statement')).toBe(id(11));
    expect(button(characters(), 'Previous page')).toBeTruthy();
    const creditSelect = host.querySelector<HTMLSelectElement>('[aria-labelledby="connections-credits"] select')!;
    creditSelect.value = otherCredit.key;
    await act(async () => creditSelect.dispatchEvent(new browser.Event('change', { bubbles: true })));
    expect(calls.at(-1)?.selection?.credits).toEqual({ stream: otherCredit.key });
    expect(host.querySelector('[aria-labelledby="connections-credits"]')?.textContent).toContain('Page 1');
    expect(host.querySelector('[aria-labelledby="connections-credits"] [data-slot="character-work-visit"]')).toBeNull();
  }));

test('a failed Previous keeps its page number and retries the same address with native refusal wording', async () =>
  mounted(async (host, render) => {
    let failPrevious = false;
    const calls: ConnectionAddress[] = [];
    const read: ConnectionRead = async (address) => {
      calls.push(address);
      return visit(address, { failPrevious });
    };
    await render(read);
    const characters = () => host.querySelector('[aria-labelledby="connections-characters"]')!;
    await act(async () => button(characters(), 'Next page').click());
    failPrevious = true;
    await act(async () => button(characters(), 'Previous page').click());
    expect(characters().textContent).toContain('Page 2');
    expect(characters().textContent).toContain('This relation is unavailable.');
    expect(characters().textContent).not.toContain('This section could not be loaded.');
    failPrevious = false;
    await act(async () => button(characters(), 'Retry').click());
    expect(calls.at(-1)?.selection?.characters).toEqual({ stream: appearance.key, reading: 'a'.repeat(64) });
    expect(characters().textContent).toContain('Page 1');
    expect(characters().querySelector(`[data-work-statement="${id(10)}"]`)).toBeTruthy();
  }));

test('caller replacement retires late rows and whole-association spoilers hide captions and evidence', async () =>
  mounted(async (host, render) => {
    let settle!: (visit: ConnectionVisit) => void;
    let count = 0;
    const read: ConnectionRead = async (address) =>
      ++count === 1
        ? new Promise((resolve) => {
            settle = resolve;
          })
        : visit(address);
    await render(read);
    await render(read, page(), id(9));
    await act(async () => settle(visit({ id: id(1), locale: 'en' }, { privateTitle: 'Retired private title' })));
    expect(host.textContent).not.toContain('Retired private title');
    expect(host.querySelector(`[data-work-statement="${id(10)}"]`)).toBeTruthy();
    await render(async (address) => visit(address, { spoiler: true }));
    expect(host.querySelector(`[data-work-statement="${id(10)}"]`)).toBeNull();
    expect(host.innerHTML).not.toContain('https://source.test/assertion-10');
    expect(host.innerHTML).not.toContain('Work 10');
  }));
