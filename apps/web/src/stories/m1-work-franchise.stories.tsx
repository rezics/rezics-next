import type { Meta, StoryObj } from '@storybook/react-vite';
import type { Subject } from '../subject/types';
import type { Related } from '../subject/types';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { WorkFranchiseOverview } from '../features/pages/showcase-work/overview';
import { PatternStory } from './page';

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

function WorkFranchiseStory() {
  const locale = getLocale();
  const workId = id(901);
  const seriesId = id(902);
  const subject = {
    id: workId,
    type: 'wd:Q689445',
    revision: 1,
    release: 'sha256:story',
    context: '00000000-0000-8000-8000-000000000000',
    labels: { en: 'A clockwork visual novel', ja: '時計仕掛けのビジュアルノベル' },
    descriptions: {},
    aliases: {},
    resolution: {},
    relationCounts: { 'wdt:P144': 1 },
    sourceRecords: [],
    statements: {
      'wdt:P144': [
        {
          id: id(903),
          rank: 'normal',
          property: { id: 'wdt:P144', data_type: 'wikibase-item' },
          value: { type: 'value', content: seriesId },
          qualifiers: [],
          references: [],
          rezics: { release: 'sha256:story', revision: 1 },
        },
      ],
    },
  } as unknown as Subject;
  const related = {
    [seriesId]: {
      type: 'schema:TVSeries',
      types: ['schema:TVSeries'],
      labels: { en: 'A clockwork television series', ja: '時計仕掛けのテレビシリーズ' },
      cover: null,
    },
  } as unknown as Related;

  return (
    <PatternStory path={`/${locale}/subjects/${workId}/clockwork-visual-novel`} visitor="Signed Out">
      <AppShell>
        <main className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-8">
          <h1 className="text-3xl font-semibold">A clockwork visual novel</h1>
          <WorkFranchiseOverview
            subject={subject}
            related={related}
            definitions={{
              'wdt:P144': { label: 'Based on', forwardLabel: 'Based on', group: 'derivation', symmetric: false },
            }}
            locale={locale}
            returnTo={`/${locale}/subjects/${workId}/clockwork-visual-novel`}
            relationsHref={`/${locale}/subjects/${workId}/clockwork-visual-novel/relations`}
          />
        </main>
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Subjects/Work franchise navigation',
  component: WorkFranchiseStory,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Illustrative fixture for the related-work card. Production links require a destination disclosed in the current native Subject read; this story is not a seeded or native acceptance pass.',
      },
    },
  },
} satisfies Meta<typeof WorkFranchiseStory>;

export default meta;
type Story = StoryObj<typeof meta>;
export const DisclosedScreenWork: Story = {};
