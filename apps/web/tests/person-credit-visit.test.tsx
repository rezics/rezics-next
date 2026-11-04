import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement as h } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { relationActor, relationFixture, relationProperty } from '../src/kernel/fake/catalogue-relations';
import definitions from '../src/kernel/recorded/definitions-release.json';
import { creditVisit, type CreditVisit } from '../src/features/catalogue/credit-inspection/model';
import { creditReturn, creditWindowHref } from '../src/features/catalogue/credit-inspection/navigation';
import { subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';
import type { OverviewValue, RowValue } from '../src/features/pages/overview';

mock.module('cloudflare:workers', () => ({ env: {} }));

test('current Person credit returns from work, Character and Sources with exact labels, Context and window; replaced and concealed rows stay unavailable', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    ...Object.fromEntries(
      [
        'HTMLElement',
        'HTMLInputElement',
        'Element',
        'Node',
        'Text',
        'NodeFilter',
        'DocumentFragment',
        'MutationObserver',
        'ResizeObserver',
        'DOMRect',
      ].map((key) => [key, Reflect.get(window, key)]),
    ),
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { CoverList } = await import('../src/features/pages/cover-list');
  const { holderItems } = await import('../src/features/pages/overview');
  const { sessionQuery } = await import('../src/session/query');
  const { defaultReader } = await import('../src/subject/reader');
  const { m } = await import('../src/paraglide/messages.js');
  const fixture = relationFixture();
  const rows = [fixture.original, fixture.sibling].map((assertion) => ({
    subject: fixture.id,
    property: relationProperty,
    statement: assertion.id,
    assertion,
    creditSlot: {
      ...fixture.slot,
      key: assertion.id === fixture.original.id ? fixture.slot.key : '00000000-0000-8000-8000-000000000103',
    },
    label: 'The same work',
    related: Object.fromEntries(
      Object.entries(fixture.publicRead.related).map(([id, value]) => [
        id,
        { id, type: value.type, label: { value: value.labels.en, language: 'en' } },
      ]),
    ),
  }));
  const section = {
    ok: true as const,
    read: {
      kind: 'links' as const,
      id: relationActor,
      property: relationProperty,
      limit: 20,
      cursor: 'current:opaque+cursor',
    },
    body: { links: rows },
  };
  const labels = Object.fromEntries(
    Object.entries(definitions.release.properties).map(([id, value]) => [id, value.labels.en]),
  );
  const visit = creditVisit(
    {
      subject: relationActor,
      context: { id: fixture.publicRead.subject.context },
      realm: '00000000-0000-8000-8000-000000000011',
      releaseDigest: fixture.publicRead.subject.release,
      candidatePropertyLabel: (id: string) => labels[id],
      relations: { [relationProperty]: { forwardLabel: 'Voice actor' } },
      relationDirections: [
        {
          state: 'admitted',
          property: relationProperty,
          direction: 'inverse',
          release: fixture.publicRead.subject.release,
        },
      ],
    } as unknown as OverviewValue,
    'voice',
    section,
    'works',
  )!;
  expect(visit.labels?.['wdt:P1932']).toBe(labels['wdt:P1932']);
  expect(creditVisit({} as OverviewValue, 'voice', section, 'credits')).toBeUndefined();
  const value: RowValue = {
    locale: 'en',
    link: (props) => h('a', props),
    reader: defaultReader,
    labels: {
      spoilerShow: 'Show',
      documentSpoiler: 'Spoiler',
      cover: { withheld: '', reveal: '', credit: '', via: '' },
    },
    unlabelled: 'Unlabelled',
    spoilerShow: 'Show',
  };
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient();
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-out' });
  let items = holderItems(section.body, 20)!.items;
  const render = (key = 'visit', selectedVisit: CreditVisit = visit) =>
    act(async () =>
      root.render(
        h(
          QueryClientProvider,
          { client },
          h(CoverList, { key, items, value, label: 'Current credits', creditVisit: selectedVisit }),
        ),
      ),
    );
  const click = async (name: string) =>
    act(async () => {
      const button = [...window.document.querySelectorAll('button')].find((button) => button.textContent === name)!;
      button.focus();
      button.click();
    });
  try {
    await render();
    await click(m.credit_inspect());
    await act(async () => {
      await import('../src/features/catalogue/credit-inspection/session');
    });
    const dialog = window.document.querySelector('[role="dialog"]');
    if (!dialog) throw new Error(`Credit inspection did not open: ${window.document.body.innerHTML}`);
    expect(dialog.textContent).toContain(labels['wdt:P1932']);
    expect(dialog.textContent).toContain('Original credit');
    expect(dialog.textContent).toContain('The traveler');
    expect(dialog.textContent).not.toContain('The narrator');
    const targets = [...dialog.querySelectorAll('a')].filter((a) => a.pathname.includes('/subjects/'));
    expect(targets.length).toBeGreaterThanOrEqual(4);
    const source = targets.find((a) => a.pathname.endsWith('/sources'))!;
    const origin = new URL(source.href).searchParams.get('via')!;
    expect(subjectVisitReturn(origin, 'en')).toBe(origin);
    const address = new URL(origin, 'https://site.test');
    expect(address.searchParams.get('cursor')).toBe('current:opaque+cursor');
    expect(address.searchParams.get('realm')).toBe(visit.realm!);
    expect(creditReturn(address.hash)).toMatchObject({ context: visit.context, statement: fixture.original.id });
    for (const target of targets) {
      expect(new URL(target.href).searchParams.get('via')).toBe(origin);
      expect(new URL(target.href).searchParams.get('realm')).toBe(visit.realm!);
      expect(target.target).toBe('_blank');
    }
    await click(m.credit_close());
    await act(async () => {
      (host.querySelectorAll('button[data-credit-statement]')[1] as HTMLButtonElement).click();
    });
    expect(window.document.querySelector('[role="dialog"]')?.textContent).toContain('The narrator');
    expect(window.document.querySelector('[role="dialog"]')?.textContent).not.toContain('The traveler');
    await click(m.credit_close());
    // A navigation back mounts a new native reading, then verifies its exact assertion before reopening.
    window.history.replaceState(null, '', origin);
    await render('fresh-return');
    expect(window.document.querySelector('[role="dialog"]')?.textContent).toContain('Original credit');
    await click(m.credit_close());
    items = holderItems({ links: [rows[1]] }, 20)!.items;
    await render('candidate-replaced');
    expect(window.document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).toContain(m.credit_return_unavailable());
    expect(host.contains(window.document.activeElement)).toBe(true);
    items = holderItems(section.body, 20)!.items.map((item) => ({ ...item, gated: true }));
    await render('concealed');
    expect(window.document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).not.toContain('The same work');
    expect(host.querySelector(`a[href*="${fixture.id}"]`)).toBeNull();
    expect(host.querySelector('[data-credit-statement]')).toBeNull();
    window.history.replaceState(null, '', '/en');
    await render('manual-reveal');
    await click('Show');
    await click(m.credit_inspect());
    expect(window.document.querySelector('[role="dialog"]')).not.toBeNull();
    // Hiding the complete association retires its portal as well as its card links.
    await act(async () => {
      (host.querySelector('[aria-expanded="true"]') as unknown as HTMLButtonElement).click();
    });
    expect(window.document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector(`a[href*="${fixture.id}"]`)).toBeNull();
    items = holderItems(section.body, 20)!.items;
    window.history.replaceState(null, '', origin);
    items = holderItems({ links: [{ ...rows[0], related: {} }] }, 20)!.items;
    await render('unlabelled-character');
    expect(window.document.querySelector('[role="dialog"]')).not.toBeNull();
    for (const link of window.document.querySelectorAll('[role="dialog"] a')) {
      expect(link.getAttribute('href')).not.toContain(fixture.slot.key!);
    }
    await click(m.credit_close());
    items = holderItems(section.body, 20)!.items;
    await render('context-replaced', { ...visit, context: '00000000-0000-8000-8000-000000000099' });
    expect(window.document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).toContain(m.credit_return_unavailable());
    await render('definition-replaced', { ...visit, definition: 'sha256:replaced' });
    expect(window.document.querySelector('[role="dialog"]')).toBeNull();
    expect(subjectVisitReturn(creditWindowHref(visit, 'en', items[0]!.credit!), 'ja')).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of saved)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  }
});
