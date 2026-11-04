import type { Release } from '@rezics/definitions';
import publicBookMetadata from '../../../../specs/fixtures/imports/bangumi/public-book-meta-tags.json';
import recordedRelease from '../kernel/recorded/definitions-release.json';
import { SubjectConceptTags } from '../features/pages/subject-slots';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { Subject, Related } from '../subject/types';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { WorkFranchiseOverview } from '../features/pages/showcase-work/overview';
import { PatternStory } from './page';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function WorkFranchiseStory() {
  const locale = getLocale(),
    workId = id(901),
    seriesId = id(902),
    route = `/${locale}/subjects/${workId}/clockwork-visual-novel`;
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
    <PatternStory path={route} visitor="Signed Out">
      <AppShell>
        <main className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-8">
          <h1 className="text-3xl font-semibold">A clockwork visual novel</h1>
          <WorkFranchiseOverview
            subject={subject}
            related={related}
            definitions={{
              'wdt:P144': {
                label: 'Based on',
                forwardLabel: 'Based on',
                group: 'derivation',
                symmetric: false,
              },
            }}
            locale={locale}
            returnTo={route}
            relationsHref={`${route}/relations`}
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
          'Illustrative fixture only. Production links require a disclosed destination in the current native Subject read.',
      },
    },
  },
} satisfies Meta<typeof WorkFranchiseStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const DisclosedScreenWork: Story = {};

/** Captured Bangumi public metadata has a tag association and supplies no source weight. */
function SuppliedTagEvidenceStory() {
  const locale = getLocale();
  const work = id(910);
  const concept = id(911);
  const source = publicBookMetadata;
  const route = `/${locale}/subjects/${work}/bangumi-book`;
  const subject = {
    id: work,
    type: 'schema:Book',
    revision: 1,
    release: 'sha256:story',
    context: '00000000-0000-8000-8000-000000000000',
    labels: { ja: source.name },
    aliases: {},
    descriptions: {},
    statements: {
      'schema:genre': [
        {
          id: id(912),
          rank: 'normal',
          property: { id: 'schema:genre', data_type: 'wikibase-item' },
          value: { type: 'value', content: concept },
          qualifiers: [],
          references: [
            {
              parts: [
                {
                  property: { id: 'schema:url', data_type: 'url' },
                  value: { type: 'value', content: `https://bgm.tv/subject/${source.id}` },
                },
              ],
            },
          ],
        },
      ],
    },
  } as unknown as Subject;
  const related = {
    [concept]: { type: 'skos:Concept', labels: { 'zh-Hans': source.meta_tags[1] } },
  } as unknown as Related;
  return (
    <PatternStory path={route} visitor="Signed Out">
      <AppShell>
        <main className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-8">
          <h1 className="text-3xl font-semibold" lang="ja">
            {source.name}
          </h1>
          <SubjectConceptTags
            subject={subject}
            related={related}
            definitions={recordedRelease.release as unknown as Release}
            locale={locale}
            spoilerThreshold={0}
            currentHref={route}
          />
        </main>
      </AppShell>
    </PatternStory>
  );
}

export const SuppliedTagWithoutWeight: Story = { render: () => <SuppliedTagEvidenceStory /> };
