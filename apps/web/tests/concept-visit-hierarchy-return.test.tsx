import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h, type ReactNode } from 'react';
import type { KernelClient, SubjectRead } from '@rezics/client';
import { bundledRelease } from '@rezics/definitions/bundled';
import { readSourceConcept, type ConceptRead } from '../src/features/catalogue/source-concept-explorer';
import {
  conceptVisitDescriptorFor,
  conceptVisitPosition,
  conceptVisitWorkIntent,
  parseConceptVisitDescriptor,
  subjectVisitHref,
} from '../src/features/pages/source-concept-reading/navigation';
import { subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';
import type { ConceptHierarchyAddress, ConceptVisitDescriptor } from '../src/features/pages/source-concept-reading/navigation';
import type { ConceptInput } from '../src/features/pages/source-concept-reading/visit';

mock.module('cloudflare:workers', () => ({ env: {} }));

const parent = '00000000-0000-4000-8000-000000000101';
const child = '00000000-0000-4000-8000-000000000102';
const work = '00000000-0000-4000-8000-000000000103';
const context = '00000000-0000-4000-8000-000000000104';
const scheme = '00000000-0000-4000-8000-000000000105';
const release = `sha256:${'a'.repeat(64)}`;
const next = 'next:原文';
const origin = `/en/subjects/${work}/steins-gate`;
const route = {
  property: 'schema:genre',
  scheme,
  type: 'schema:Book',
  includeChildren: true,
  spoilerThreshold: 1 as const,
  conditionText: JSON.stringify({ statement: { property: 'schema:datePublished', in: ['2009'] } }),
  tagQualifiersText: JSON.stringify([{ property: 'rezics:spoilerLevel', in: ['1'] }]),
};

function subject(id: string, version: string = release): SubjectRead {
  const result: SubjectRead = {
    subject: {
      id,
      type: 'skos:Concept',
      revision: 7,
      release: version,
      context,
      labels: { en: id === parent ? 'Parent concept' : 'Child concept' },
      descriptions: {},
      aliases: {},
      statements: {
        'skos:inScheme': [
          {
            id: '00000000-0000-4000-8000-000000000106',
            rank: 'normal',
            property: { id: 'skos:inScheme', data_type: 'wikibase-item' },
            value: { type: 'value', content: scheme },
            qualifiers: [],
            references: [],
            rezics: { release: version, revision: 7 },
          },
        ],
      },
      resolution: {},
      relationCounts: {},
      sourceRecords: [],
    },
    related: { [scheme]: { type: 'skos:ConceptScheme', labels: { en: 'Source scheme' } } },
    account: null,
    summary: null,
  };
  Object.assign(result, { viewerActions: { state: 'available', actions: [] } });
  return result;
}

async function nativeRead(
  id: string,
  input: ConceptInput = {},
  options: { release?: string; receipt?: string; concealChild?: boolean } = {},
): Promise<ConceptRead> {
  const value = subject(id, options.release);
  const receipt = options.receipt ?? 'fresh-receipt';
  const client = {
    subjects: () => ({
      get: async () => ({ status: 200, data: value, headers: { 'rezics-session-token': receipt } }),
      links: {
        get: async () => ({
          status: 200,
          headers: { 'rezics-session-token': receipt },
          data: {
            links:
              id === parent && !options.concealChild
                ? [
                    {
                      subject: child,
                      property: 'skos:broader',
                      statement: child,
                      related: {},
                      summary: {
                        id: child,
                        type: 'skos:Concept',
                        label: { value: input.cursor ? 'Child on selected page' : 'Child concept', language: 'en' },
                        types: ['skos:Concept'],
                        creativeWork: false,
                        cover: null,
                      },
                    },
                  ]
                : [],
            next: id === parent && !input.cursor ? next : null,
            freshness: { consistency: 'eventual', target_seconds: 10, caught_up: true },
            ...(id !== parent || options.concealChild
              ? { count: { value: 0, exact: true } }
              : {}),
          },
        }),
      },
    }),
  } as unknown as KernelClient;
  return readSourceConcept(client, undefined, { ...bundledRelease, digest: release }, id, 'en', input);
}

function position(id: string = parent): ConceptHierarchyAddress {
  return {
    subject: id,
    current: { release, revision: 7, context, type: 'skos:Concept' },
    addresses: [null, next],
    index: 1,
    truncated: false,
    focus: { section: 'hierarchy', row: child },
  };
}

async function mounted(
  run: (page: {
    host: HTMLElement;
    render: (node: ReactNode) => Promise<void>;
  }) => Promise<void>,
) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en' });
  const globals = {
    ...Object.fromEntries(
      [
        'document',
        'navigator',
        'HTMLElement',
        'HTMLButtonElement',
        'Node',
        'Element',
        'Document',
        'DocumentFragment',
        'MutationObserver',
        'ShadowRoot',
      ].map(
        (key) => [key, window[key]],
      ),
    ),
    window,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  try {
    await run({ host, render: (node) => act(async () => root.render(node)) });
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function pendingReads() {
  const calls: {
    id: string;
    input: ConceptInput;
    resolve: (read: ConceptRead) => void;
  }[] = [];
  return {
    calls,
    read: (id: string, input: ConceptInput) =>
      new Promise<ConceptRead>((resolve) => calls.push({ id, input, resolve })),
    complete: async (index: number, options: { release?: string; concealChild?: boolean } = {}) => {
      const call = calls[index]!;
      await act(async () =>
        call.resolve(
          await nativeRead(call.id, call.input, { ...options, receipt: call.input.session ?? `fresh-${index}` }),
        ),
      );
    },
  };
}

test('walks to a child and back to the freshly admitted Concept window with its work origin kept separately', async () => {
  const { SourceConceptView } = await import('../src/features/pages/source-concept-view');
  const pending = pendingReads();
  const base = await nativeRead(parent);
  if (!base.ok) throw new Error('fixture Concept was not admitted');
  const savedDescriptor = conceptVisitDescriptorFor(
    base,
    { addresses: [undefined, next], truncated: false },
    1,
    route,
    { section: 'hierarchy', row: child },
  );
  const descriptor = parseConceptVisitDescriptor(savedDescriptor);
  expect(descriptor?.works).toEqual(route);
  expect(descriptor?.addresses).toEqual([null, next]);

  await mounted(async ({ host, render }) => {
    type VisitProps = Pick<Parameters<typeof SourceConceptView>[0], 'hierarchyAddress' | 'conceptVisit' | 'worksRoute'>;
    const show = (id: string, extra: Partial<VisitProps> = {}) =>
      render(
        h(SourceConceptView, {
          id,
          locale: 'en',
          returnTo: origin,
          transport: { read: (input: ConceptInput) => pending.read(id, input) },
          ...extra,
        }),
      );

    await show(parent, { hierarchyAddress: position(), worksRoute: route });
    await pending.complete(0);
    expect(pending.calls[1]!.input).toEqual({ cursor: next, session: 'fresh-0' });
    await pending.complete(1);
    const childRow = host.querySelector(`[data-concept-hierarchy-row="${child}"]`)!;
    const childLink = childRow.querySelector('a') as HTMLAnchorElement;
    expect(document.activeElement).toBe(childLink);
    const childAddress = new URL(childLink.href);
    const visit = parseConceptVisitDescriptor(childAddress.searchParams.get('conceptVisit'));
    expect(childAddress.pathname).toContain(`/${child}/`);
    expect(childAddress.searchParams.get('returnTo')).toBe(origin);
    expect(visit?.subject).toBe(parent);
    expect(visit?.works).toEqual(route);

    await show(child, { conceptVisit: visit });
    await pending.complete(2);
    const previous = [...host.querySelectorAll('a')].find((link) => link.textContent === 'Return to previous Concept')!;
    const previousAddress = new URL((previous as HTMLAnchorElement).href);
    expect(previousAddress.pathname).toContain(`/${parent}/`);
    expect(previousAddress.searchParams.get('returnTo')).toBe(origin);
    expect(parseConceptVisitDescriptor(previousAddress.searchParams.get('conceptVisit'))?.focus).toEqual({
      section: 'hierarchy',
      row: child,
    });
    const resultHref = subjectVisitHref(`/en/subjects/${work}/steins-gate`, previousAddress.pathname + previousAddress.search);
    expect(subjectVisitReturn(new URL(resultHref, window.location.href).searchParams.get('via'), 'en')).toBe(
      previousAddress.pathname + previousAddress.search,
    );

    const returned = parseConceptVisitDescriptor(previousAddress.searchParams.get('conceptVisit'))!;
    await show(parent, { conceptVisit: returned, hierarchyAddress: conceptVisitPosition(returned), worksRoute: conceptVisitWorkIntent(returned) });
    await pending.complete(3);
    expect(pending.calls[4]!.input).toEqual({ cursor: next, session: 'fresh-3' });
    await pending.complete(4);
    expect(host.textContent).toContain('Child on selected page');

    // Back to page one, then Forward to the saved window: both route changes admit again.
    await show(parent, {
      conceptVisit: returned,
      hierarchyAddress: { ...position(), addresses: [null], index: 0, focus: undefined },
      worksRoute: conceptVisitWorkIntent(returned),
    });
    expect(pending.calls[5]!.input).toEqual({});
    await pending.complete(5);
    expect(pending.calls).toHaveLength(6);
    await show(parent, { conceptVisit: returned, hierarchyAddress: conceptVisitPosition(returned), worksRoute: route });
    await pending.complete(6);
    expect(pending.calls[7]!.input).toEqual({ cursor: next, session: 'fresh-6' });
    await pending.complete(7);
    expect(document.activeElement?.getAttribute('href')).toContain(`/${child}/`);
  });
});

test('a changed binding never restores its old cursor; a concealed row announces restart at the current section', async () => {
  const { SourceConceptView } = await import('../src/features/pages/source-concept-view');
  await mounted(async ({ host, render }) => {
    const pending = pendingReads();
    await render(
      h(SourceConceptView, {
        id: parent,
        locale: 'en',
        transport: { read: (input: ConceptInput) => pending.read(parent, input) },
        hierarchyAddress: position(),
      }),
    );
    await pending.complete(0, { release: `sha256:${'b'.repeat(64)}` });
    expect(pending.calls).toHaveLength(1);
    expect(host.textContent).toContain('changed while you were away');
    expect(document.activeElement?.id).toBe('concept-narrower-heading');
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'Restart hierarchy')).toBe(true);
  });

  await mounted(async ({ host, render }) => {
    const pending = pendingReads();
    await render(
      h(SourceConceptView, {
        id: parent,
        locale: 'en',
        transport: { read: (input: ConceptInput) => pending.read(parent, input) },
        hierarchyAddress: position(),
      }),
    );
    await pending.complete(0);
    await pending.complete(1, { concealChild: true });
    expect(host.textContent).toContain('selected row is no longer disclosed');
    expect(document.activeElement?.id).toBe('concept-narrower-heading');
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'Restart hierarchy')).toBe(true);
  });
});

test('a lost descriptor and unsupported pin keep a fresh Concept and the safe work return', async () => {
  const { SourceConceptView } = await import('../src/features/pages/source-concept-view');
  await mounted(async ({ host, render }) => {
    const pending = pendingReads();
    await render(
      h(SourceConceptView, {
        id: child,
        locale: 'en',
        returnTo: origin,
        pinUnsupported: true,
        invalidConceptVisit: true,
        transport: { read: (input: ConceptInput) => pending.read(child, input) },
      }),
    );
    await pending.complete(0);
    expect(host.textContent).toContain('Child concept');
    expect(host.textContent).toContain('This saved Concept position could not be used');
    expect(host.textContent).toContain('cannot resolve pinned history');
    expect(host.textContent).not.toContain('Child on selected page');
    const originalReturn = [...host.querySelectorAll('a')]
      .map((link) => new URL((link as HTMLAnchorElement).href))
      .find((url) => url.searchParams.get('returnTo') === origin);
    expect(originalReturn).toBeDefined();
  });
});

test('strict visit and Subject-return bounds reject malformed, oversized, and recursive intent', async () => {
  const base = await nativeRead(parent);
  if (!base.ok) throw new Error('fixture Concept was not admitted');
  const { originatingConceptReturn } = await import('../src/features/pages/source-concept-reading/origin');
  const encoded = conceptVisitDescriptorFor(
    base,
    { addresses: [undefined, next], truncated: false },
    1,
    route,
    { section: 'works' },
  )!;
  expect(parseConceptVisitDescriptor(encoded)?.subject).toBe(parent);
  expect(parseConceptVisitDescriptor(`${encoded}!`)).toBeUndefined();
  expect(parseConceptVisitDescriptor('a'.repeat(8193))).toBeUndefined();
  expect(originatingConceptReturn(`/en/subjects/${work}/${'概'.repeat(800)}`, 'en')).toBeUndefined();
  const address = `/en/subjects/${parent}/parent-concept/concepts?conceptVisit=${encoded}&returnTo=${encodeURIComponent(origin)}`;
  expect(subjectVisitReturn(address, 'en')).toBe(address);
  expect(subjectVisitReturn(address + '&cursor=old-work-cursor', 'en')).toBeUndefined();
  const recursive = `/en/subjects/${parent}/parent-concept/concepts?conceptVisit=${encoded}&returnTo=${encodeURIComponent(address)}`;
  expect(subjectVisitReturn(recursive, 'en')).toBeUndefined();
});
