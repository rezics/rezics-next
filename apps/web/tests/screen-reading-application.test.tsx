import { expect, mock, test } from 'bun:test';
import { act, createElement as h, useState } from 'react';
import type { ScreenPageValueProps, ScreenSpoilerGateProps } from '../src/features/catalogue/screen-reading-port';
import { ScreenReadingApplicationProvider } from '../src/features/catalogue/screen-reading-application';
import {
  screenEpisodeContinuationHref,
  screenEpisodeReturn,
  screenEpisodeSubjectHref,
  screenEpisodeWindowAddress,
} from '../src/features/catalogue/screen-episode-reader/navigation';
import { ScreenEpisodeList } from '../src/features/catalogue/screen-episode-reader/view';
import type { ScreenEpisodeEntry, ScreenEpisodeRead } from '../src/features/catalogue/screen-episode-reader/read';

mock.module('cloudflare:workers', () => ({ env: {} }));

const seriesId = '00000000-0000-4000-8000-000000000901';
const membershipId = '00000000-0000-4000-8000-000000000912';
const concealedMembershipId = '00000000-0000-4000-8000-000000000914';
const origin = {
  pathname: `/en/subjects/${seriesId}/the-observatory`,
  searchStr: '?screenCursor=page-two&realm=00000000-0000-4000-8000-000000000904',
};

function PageValue({ snak }: ScreenPageValueProps) {
  return <span data-page-value="">{String(snak.value.content ?? '')}</span>;
}

function SpoilerGate({ label, hideLabel, children }: ScreenSpoilerGateProps) {
  const [shown, setShown] = useState(false);
  return (
    <div data-spoiler-gate="">
      <button type="button" aria-expanded={shown} onClick={() => setShown((current) => !current)}>
        {shown ? (hideLabel ?? label) : label}
      </button>
      {shown ? children : null}
    </div>
  );
}

const port = {
  PageValue,
  SpoilerGate,
  visitReturn: (value: unknown) => (typeof value === 'string' && value.startsWith('/') ? value : undefined),
  subjectHref: (subject: { id: string; label: string }, locale: string) => ({
    href: `/${locale}/subjects/${subject.id}/${subject.label.toLowerCase().replaceAll(' ', '-')}`,
  }),
};

function entry(id: string, label: string, reference: string, spoiled = false): ScreenEpisodeEntry {
  return {
    membershipId: id,
    holderId: id,
    parentId: seriesId,
    context: '00000000-0000-4000-8000-000000000906',
    id,
    type: 'schema:Episode',
    label,
    typeLabel: { text: 'Episode', lang: 'en' },
    statement: {
      id,
      rank: 'normal',
      property: { id: 'schema:isPartOf', data_type: 'wikibase-item' },
      value: { type: 'value', content: seriesId },
      qualifiers: spoiled
        ? [
            {
              property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
              value: { type: 'value', content: { amount: '+2', unit: '1' } },
            },
          ]
        : [],
      references: [
        {
          parts: [
            {
              property: { id: 'schema:url', data_type: 'url' },
              value: { type: 'value', content: reference },
            },
          ],
          hash: id,
        },
      ],
    },
  };
}

test('screen reading application preserves bounded navigation and discloses evidence after Inspect', async () => {
  const windowAddress = screenEpisodeWindowAddress(origin);
  expect(windowAddress).toContain('screenCursor=page-two');
  expect(windowAddress).not.toContain('screenSelection=');
  expect(screenEpisodeContinuationHref(origin, 'next-window')).toContain('screenCursor=next-window');

  const listed = `${origin.pathname}${origin.searchStr}#screen-episode-list`;
  const via = `${listed.replace('#screen-episode-list', '')}&screenSelection=${membershipId}#screen-episode-entry-${membershipId}`;
  expect(screenEpisodeReturn(`?via=${encodeURIComponent(via)}`, 'en', port.visitReturn)).toEqual({
    href: via,
    membershipId,
  });
  expect(
    screenEpisodeSubjectHref(
      entry(membershipId, 'The Special', 'https://example.invalid/source'),
      'The Special',
      'en',
      origin,
      {
        subjectHref: port.subjectHref,
        visitReturn: port.visitReturn,
      },
    ),
  ).toContain('via=');

  const read: ScreenEpisodeRead = {
    ok: true,
    state: 'ready',
    entries: [
      entry(membershipId, 'The Special', 'https://example.invalid/source'),
      entry(concealedMembershipId, 'Concealed special', 'https://example.invalid/concealed', true),
    ],
    next: 'next-window',
  };
  const { Window } = await import('happy-dom');
  const window = new Window({ url: 'https://site.invalid' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const host = document.body.appendChild(document.createElement('main'));
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(h(ScreenReadingApplicationProvider, { port }, h(ScreenEpisodeList, { locale: 'en', origin, read }))),
    );
    expect(host.querySelector('[data-page-value]')).toBeNull();
    expect(host.textContent).not.toContain('Concealed special');
    expect(host.innerHTML).not.toContain('https://example.invalid/concealed');
    expect([...host.querySelectorAll('a')].some((anchor) => anchor.href.includes('screenCursor=next-window'))).toBe(
      true,
    );

    const inspect = host.querySelector<HTMLButtonElement>('ul li button');
    expect(inspect?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      inspect!.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(inspect?.getAttribute('aria-expanded')).toBe('true');
    expect([...host.querySelectorAll('[data-page-value]')].map((node) => node.textContent)).toEqual([
      'https://example.invalid/source',
    ]);
    expect(host.textContent).not.toContain('Concealed special');
    expect(host.innerHTML).not.toContain('https://example.invalid/concealed');
  } finally {
    await act(async () => root.unmount());
    window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
