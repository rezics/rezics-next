import { useLayoutEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { pickText } from '@rezics/composition';
import { SubjectHeaderActions } from '../features/pages/subject-reactions-view';
import { SubjectPage } from '../features/pages/subject';
import { subjectPageMessages, viewTabLabels } from '../features/pages/route-support';
import { subjectTabs } from '../features/pages/views';
import { RatingsPreviewContext } from '../features/pages/subject-ratings-view';
import { SubjectLibrarySlot } from '../library/subject-slot-view';
import { AppShell } from '../shell/shell';
import { getLocale } from '../paraglide/runtime';
import { subjectHref } from '../subject/subject-href';
import { ratingsFixtures } from '../kernel/fake/ratings';
import {
  readingOverviewExample,
  selectReadingOverviewExample,
  type ReadingExampleDomain,
  type ReadingExampleState,
} from '../kernel/fake/reading-overview';
import { PatternStory } from './page';

function CompleteReadingPage({ domain, state }: { domain: ReadingExampleDomain; state: ReadingExampleState }) {
  const [fixture] = useState(() => readingOverviewExample(domain, state));
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    selectReadingOverviewExample(fixture);
    setReady(true);
    return () => selectReadingOverviewExample();
  }, [fixture]);
  if (!ready) return null;
  const locale = getLocale();
  const { identity, page, release } = fixture;
  const path = subjectHref({ id: identity.id, label: identity.title }, locale).href;
  const ratings = ratingsFixtures[state === 'sparse' ? 'subject-ratings-empty' : 'subject-ratings-global'].preview;
  return (
    <PatternStory visitor="Signed Out" path={path}>
      <AppShell>
        <RatingsPreviewContext.Provider value={ratings}>
          <SubjectPage
            page={page}
            view="overview"
            locale={locale}
            messages={subjectPageMessages()}
            tabs={subjectTabs(page)}
            tabLabels={viewTabLabels()}
            typeLabel={pickText(release.types[identity.type]?.labels ?? {}, locale).text}
            renderJsonLd={false}
            actions={({ id, type }) => (
              <SubjectHeaderActions
                id={id}
                reactions={null}
                signedIn={false}
                returnTo={path}
                verification={{ sitekey: '', scriptUrl: '' }}
              >
                <SubjectLibrarySlot
                  subject={{ id, type, label: identity.title }}
                  locale={locale}
                  data={{
                    session: 'signed-out',
                    csrfToken: null,
                    entryAvailable: false,
                    entry: null,
                    publicCollections: null,
                    publicCollectionsNext: null,
                    collectionsLoaded: false,
                    collections: null,
                    labels: null,
                  }}
                />
              </SubjectHeaderActions>
            )}
          />
        </RatingsPreviewContext.Provider>
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Subjects/Reading first',
  id: 'pages-subjects-reading-first',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Authored contract-shaped examples on the complete native Subject page, not recorded provider responses or publication evidence. Book comprehensive fixtures remain in the literary showcase. Cover, native media and hydration acceptance belong to their owners.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function example(domain: ReadingExampleDomain, state: ReadingExampleState): Story {
  return {
    render: () => <CompleteReadingPage key={`${domain}:${state}`} domain={domain} state={state} />,
    play: async ({ canvasElement }) => {
      const fixture = readingOverviewExample(domain, state);
      const canvas = within(canvasElement);
      const title = await canvas.findByRole('heading', { level: 1, name: fixture.identity.title });
      const details = canvasElement.querySelector('[data-slot="reading-overview-tools"]');
      await expect(details).toBeInTheDocument();
      await expect(details).not.toHaveAttribute('open');
      await expect(canvasElement.querySelectorAll('[data-slot="subject-header"]')).toHaveLength(1);
      await expect(title.textContent).not.toMatch(/schema:|wd:/);
      if (state === 'rich') {
        await canvas.findByText('A quiet story with a lasting afterglow');
        await expect(canvas.queryByText('Notes for a second visit')).not.toBeInTheDocument();
      }
    },
  };
}

export const BookRich: Story = example('book', 'rich');
export const BookSparse: Story = example('book', 'sparse');
export const BookSectionFailure: Story = example('book', 'section-failure');
export const GameRich: Story = example('game', 'rich');
export const GameSparse: Story = example('game', 'sparse');
export const GameSectionFailure: Story = example('game', 'section-failure');
export const AnimeRich: Story = example('anime', 'rich');
export const AnimeSparse: Story = example('anime', 'sparse');
export const AnimeSectionFailure: Story = example('anime', 'section-failure');
