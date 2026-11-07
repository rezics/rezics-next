import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ScreenPageValueProps, ScreenSpoilerGateProps } from '../src/features/catalogue/screen-reading-port';
import { ScreenReadingApplicationProvider } from '../src/features/catalogue/screen-reading-application';
import {
  screenEpisodeContinuationHref,
  screenEpisodeReturn,
  screenEpisodeSubjectHref,
  screenEpisodeWindowAddress,
} from '../src/features/catalogue/screen-episode-reader/navigation';
import { ScreenEpisodeList } from '../src/features/catalogue/screen-episode-reader/view';
import type { ScreenEpisodeEntry } from '../src/features/catalogue/screen-episode-reader/read';

mock.module('cloudflare:workers', () => ({ env: {} }));

const seriesId = '00000000-0000-4000-8000-000000000901';
const episodeId = '00000000-0000-4000-8000-000000000903';
const membershipId = '00000000-0000-4000-8000-000000000912';
const origin = {
  pathname: `/en/subjects/${seriesId}/the-observatory`,
  searchStr: '?screenCursor=page-two&realm=00000000-0000-4000-8000-000000000904',
};

function PageValue({ snak }: ScreenPageValueProps) {
  return <span data-page-value="">{String(snak.value.content ?? '')}</span>;
}

function SpoilerGate({ children }: ScreenSpoilerGateProps) {
  return <div data-spoiler-gate="">{children}</div>;
}

const port = {
  PageValue,
  SpoilerGate,
  visitReturn: (value: unknown) => (typeof value === 'string' && value.startsWith('/') ? value : undefined),
  subjectHref: (subject: { id: string; label: string }, locale: string) => ({
    href: `/${locale}/subjects/${subject.id}/${subject.label.toLowerCase().replaceAll(' ', '-')}`,
  }),
};

test('screen reading application constructs episode continuation from injected page capabilities', () => {
  const window = screenEpisodeWindowAddress(origin);
  expect(window).toContain('screenCursor=page-two');
  expect(window).not.toContain('screenSelection=');
  expect(screenEpisodeContinuationHref(origin, 'next-window')).toContain('screenCursor=next-window');

  const listed = `${origin.pathname}${origin.searchStr}#screen-episode-list`;
  const via = `${listed.replace('#screen-episode-list', '')}&screenSelection=${membershipId}#screen-episode-entry-${membershipId}`;
  const returned = screenEpisodeReturn(`?via=${encodeURIComponent(via)}`, 'en', port.visitReturn);
  expect(returned).toEqual({ href: via, membershipId });

  const entry: ScreenEpisodeEntry = {
    membershipId,
    holderId: episodeId,
    parentId: seriesId,
    context: '00000000-0000-4000-8000-000000000906',
    id: episodeId,
    type: 'schema:Episode',
    label: 'The Special',
    typeLabel: { text: 'Episode', lang: 'en' },
    statement: {
      id: membershipId,
      rank: 'normal',
      property: { id: 'schema:isPartOf', data_type: 'wikibase-item' },
      value: { type: 'value', content: seriesId },
      qualifiers: [],
      references: [],
    },
  };
  const href = screenEpisodeSubjectHref(entry, entry.label!, 'en', origin, {
    subjectHref: port.subjectHref,
    visitReturn: port.visitReturn,
  });
  expect(href).toContain(`/en/subjects/${episodeId}/the-special`);
  expect(href).toContain('via=');

  const html = renderToStaticMarkup(
    <ScreenReadingApplicationProvider port={port}>
      <ScreenEpisodeList
        locale="en"
        origin={origin}
        read={{ ok: true, state: 'ready', entries: [entry], next: 'next-window' }}
      />
    </ScreenReadingApplicationProvider>,
  );
  expect(html).toContain('data-page-value');
  expect(html).toContain(`/en/subjects/${episodeId}/the-special`);
  expect(html).toContain('screenCursor=next-window');
});
