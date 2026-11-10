import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { CharacterReader } from '../features/pages/showcase-people/character';
import { OverviewContext, type OverviewValue } from '../features/pages/overview';
import { characterPublicExample } from '../features/catalogue/character-public-reading/examples';
import type { CharacterPage } from '../features/catalogue/character-reading-port';
import { getLocale } from '../paraglide/runtime';
import { PatternStory } from './page';

function pageOverview(page: CharacterPage): OverviewValue {
  const labels: OverviewValue['labels'] = {
    spoilerShow: page.spoilerShow,
    documentSpoiler: page.spoilerShow,
    cover: { withheld: '', reveal: '', credit: '', via: '' },
  };
  if (page.labels.spoilerHide !== undefined) labels.spoilerHide = page.labels.spoilerHide;
  const value: OverviewValue = {
    locale: page.locale,
    subject: page.subject,
    link: page.link,
    reader: page.reader,
    labels,
    unlabelled: page.unlabelled,
    spoilerShow: page.spoilerShow,
    details: '',
    cover: '',
    coverVia: '',
    licence: '',
    source: '',
    sources: '',
    sections: new Map(),
    relations: {},
    relationNodes: page.relationNodes ?? [],
  };
  if (page.subjectLabel !== undefined) value.subjectLabel = page.subjectLabel;
  if (page.releaseDigest !== undefined) value.releaseDigest = page.releaseDigest;
  if (page.currentHref !== undefined) value.currentHref = page.currentHref;
  if (page.context !== undefined) value.context = page.context;
  if (page.realm !== undefined) value.realm = page.realm;
  if (page.cacheReader !== undefined) value.cacheReader = page.cacheReader;
  if (page.candidatePropertyLabel !== undefined) value.candidatePropertyLabel = page.candidatePropertyLabel;
  if (page.relationDirections !== undefined) value.relationDirections = page.relationDirections;
  return value;
}

function Example({ state = 'current' }: { state?: 'current' | 'spoiler' | 'stale' | 'unavailable' }) {
  const locale = getLocale();
  const fixture = useMemo(() => characterPublicExample(locale, state), [locale, state]);
  const value = useMemo(() => pageOverview(fixture.value), [fixture.value]);
  return (
    <PatternStory>
      <main className="mx-auto max-w-5xl p-4 sm:p-6">
        <OverviewContext.Provider value={value}>
          <CharacterReader
            public={fixture.profile.read}
            release={fixture.profile.release}
            locale={locale}
            associations={{ source: fixture, viewer: null, read: fixture.read }}
          />
        </OverviewContext.Provider>
      </main>
    </PatternStory>
  );
}
const meta = {
  title: 'Subjects/Character public reading',
  id: 'pages-subjects-character-public-reading',
  component: Example,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Current: Story = {};
export const Spoiler: Story = { args: { state: 'spoiler' } };
export const Stale: Story = { args: { state: 'stale' } };
export const Unavailable: Story = { args: { state: 'unavailable' } };
