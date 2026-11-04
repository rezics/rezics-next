import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrganizationOverview } from '../src/features/catalogue/organization-reader/overview';
import { OrganizationReader } from '../src/features/catalogue/organization-reader/view';
import { organizationCurrent } from '../src/features/catalogue/organization-reader';
import type { PeopleRead } from '../src/features/catalogue/people-profile';
import { peopleProfileFixture } from '../src/kernel/fake/catalogue-people-profile';
import { personReaderExample } from '../src/features/catalogue/person-reader/examples';
import { connectionReturnHref, withSubjectVisitReturn } from '../src/features/pages/subject-visit-navigation';
import { m } from '../src/paraglide/messages.js';

function reading() {
  const { release, organization: publicRead } = peopleProfileFixture('ready', 'en', 'organization');
  const example = personReaderExample();
  const fact = example.read.subject.statements['schema:abstract']![0]!;
  publicRead.subject.statements['schema:abstract'] = [fact];
  const documents = structuredClone(example.documents) as Record<string, Record<string, unknown>>;
  documents[fact.id]!.subjectId = publicRead.subject.id;
  const read = organizationCurrent(
    { ok: true, public: publicRead, release, work: null, profiles: [], credits: [] },
    publicRead.subject.id,
    publicRead.subject.context,
  )!;
  return { read, documents, fact };
}

async function mounted(
  run: (context: {
    host: HTMLElement;
    window: Window;
    client: QueryClient;
    render: (element: React.ReactNode) => Promise<void>;
    click: (name: string) => Promise<void>;
  }) => Promise<void>,
) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/subjects/organization/studio' });
  const globals = {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  try {
    await run({
      host,
      window: window as unknown as Window,
      client,
      render: async (element) => {
        await act(async () => root.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>));
      },
      click: async (name) => {
        await act(async () =>
          [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === name)!.click(),
        );
      },
    });
  } finally {
    await act(async () => root.unmount());
    client.clear();
    window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('composition documents stay together; exact inspection closes to its opener, and replacement offers current recovery', async () => {
  await mounted(async ({ host, window, client, render, click }) => {
    const { read, documents, fact } = reading();
    const realm = '00000000-0000-4000-8000-00000000d401';
    const returnTo = connectionReturnHref(read.public.subject.id, 'Studio', 'en', realm, { stream: 'out:wdt:P1365' });
    let requests = 0;
    const fallback = async () => {
      requests++;
      return read;
    };
    const show = (source: object, current = read) =>
      render(
        <OrganizationOverview
          id={current.public.subject.id}
          context={current.public.subject.context}
          source={source}
          locale="en"
          reader={null}
          public={current.public}
          release={current.release}
          documents={documents}
          read={fallback}
          realm={realm}
          returnTo={returnTo}
        />,
      );
    await show({});
    expect(requests).toBe(0);
    expect(host.textContent).toContain('Mira directs independent films.');
    const opener = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === m.organization_reader_inspect(),
    )!;
    opener.focus();
    await click(m.organization_reader_inspect());
    const inspection = host.querySelector('[role="region"]')!;
    expect(window.document.activeElement).toBe(inspection);
    const correction = inspection.querySelector('a')!;
    expect(new URL(correction.href).searchParams.get('statement')).toBe(fact.id);
    expect(new URL(correction.href).searchParams.get('via')).toBe(returnTo);
    expect(host.textContent).toContain(m.organization_reader_navigation());
    const nested = withSubjectVisitReturn(correction.getAttribute('href')!, returnTo, 'en');
    expect(new URL(nested, 'https://site.test').searchParams.getAll('via')).toEqual([returnTo]);
    await click(m.organization_reader_return());
    expect(window.document.activeElement).toBe(opener);
    await click(m.organization_reader_inspect());
    const replacement = structuredClone(read);
    replacement.public.subject.statements['schema:abstract'] = [];
    await show({}, replacement);
    expect(host.textContent).toContain(m.organization_reader_changed());
    expect(host.querySelector('[role="region"]')).toBeNull();
    expect(host.textContent).not.toContain('Mira directs independent films.');
    await click(m.organization_reader_return());
    expect(window.document.activeElement).toBe(host.querySelector('h2'));
    await act(async () => client.setQueryData(['session'], { state: 'signed-out', csrfToken: null }));
    expect(host.textContent).toContain(m.organization_reader_unavailable());
    expect(host.querySelectorAll('button')).toHaveLength(0);
  });
});

test('failed current dependency retries once, distinguishes pending, and rejects retired locale/source work without borrowed bodies', async () => {
  await mounted(async ({ host, window, client, render, click }) => {
    const { read, documents } = reading();
    const pending: { resolve: (read: PeopleRead) => void; reject: () => void; signal: AbortSignal }[] = [];
    const dependency = (_id: string, signal: AbortSignal) =>
      new Promise<PeopleRead>((resolve, reject) =>
        pending.push({ resolve, reject: () => reject(new Error('unavailable')), signal }),
      );
    let source = {};
    const show = (locale = 'en') =>
      render(
        <OrganizationOverview
          id={read.public.subject.id}
          context={read.public.subject.context}
          source={source}
          locale={locale}
          reader={null}
          documents={documents}
          read={dependency}
        />,
      );
    await show();
    expect(host.textContent).toContain(m.candidate_loading());
    expect(host.querySelectorAll('button')).toHaveLength(0);
    await act(async () => pending[0]!.reject());
    expect(host.textContent).toContain(m.organization_reader_failed());
    await click(m.correction_retry());
    expect(pending).toHaveLength(2);
    expect(host.textContent).toContain(m.candidate_loading());
    const outside = window.document.createElement('button');
    window.document.body.append(outside);
    outside.focus();
    await act(async () => pending[1]!.resolve(read));
    expect(window.document.activeElement).toBe(outside);
    expect(host.textContent).not.toContain('Mira directs independent films.');
    expect(host.textContent).toContain(m.candidate_value_unavailable());
    source = {};
    await show();
    await show('ja');
    expect(pending[2]!.signal.aborted).toBe(true);
    await act(async () => pending[2]!.resolve(read));
    expect(host.textContent).not.toContain('Mira directs independent films.');
    source = {};
    await show();
    const old = pending[3]!;
    await act(async () => client.setQueryData(['exposure', 'viewer'], { revision: 1 }));
    expect(old.signal.aborted).toBe(true);
    await act(async () => old.resolve(read));
    expect(host.querySelectorAll('button')).toHaveLength(0);
    expect(host.textContent).toContain(m.organization_reader_refresh());
  });
});

test('explicit spoiler reveals and concealed identities never survive equal success, A/B/A or viewer replacement', async () => {
  await mounted(async ({ host, client, render, click }) => {
    const { read, documents, fact } = reading();
    fact.qualifiers = [
      {
        property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
        value: { type: 'value', content: { amount: '+2', unit: '1' } },
      },
    ];
    const a = {},
      b = {};
    const show = (source: object, locale = 'en') =>
      render(<OrganizationReader read={read} documents={documents} source={source} locale={locale} />);
    await show(a);
    expect(host.textContent).not.toContain('Mira directs independent films.');
    await click(m.subject_spoiler_show());
    expect(host.textContent).toContain('Mira directs independent films.');
    await click(m.subject_spoiler_hide());
    expect(host.textContent).not.toContain('Mira directs independent films.');
    await click(m.subject_spoiler_show());
    await show(b);
    await show(a);
    expect(host.textContent).not.toContain('Mira directs independent films.');
    await click(m.subject_spoiler_show());
    await act(async () => client.setQueryData(['session'], { state: 'signed-out', csrfToken: null }));
    expect(host.textContent).not.toContain('Mira directs independent films.');
    await act(async () => client.setQueryData(['session'], { state: 'signed-out', csrfToken: null }));
    expect(host.textContent).not.toContain('Mira directs independent films.');
    expect(host.querySelectorAll('button')).toHaveLength(0);
  });
});
