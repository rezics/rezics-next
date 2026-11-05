import type { Meta, StoryObj } from '@storybook/react-vite';
import { pickText } from '@rezics/composition';
import recorded from '../kernel/recorded/definitions-release.json';
import { relationDefinitions } from '../subject/relations';
import type { Subject } from '../subject/types';
import { OverviewContext, type OverviewValue } from '../features/pages/overview';
import { PlainLink } from '../features/pages/shared';
import { WorkFranchiseOverview } from '../features/pages/showcase-work/overview';
import type { ProfileRelationWindow } from '../features/pages/views';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const property = 'wdt:P155';
const summary = {
  id: id(2),
  type: 'schema:Book',
  types: ['schema:Book'],
  label: { value: '海辺の物語', language: 'ja' },
  cover: null,
};
function assertion(n: number, inverse = false, spoiler = false) {
  return {
    id: id(n),
    rank: 'normal',
    property: { id: property, data_type: 'wikibase-item' },
    value: { type: 'value', content: id(inverse ? 1 : 2) },
    qualifiers: spoiler
      ? [
          {
            property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
            value: { type: 'value', content: { amount: '+1', unit: '1' } },
          },
        ]
      : [],
    references: [],
    rezics: { revision: 1, release: recorded.digest },
  };
}
function GroupedWorkStory() {
  const locale = getLocale();
  const route = `/${locale}/subjects/${id(1)}/source-work`;
  const definitions = relationDefinitions(recorded.release, [property, 'wdt:P144', 'wdt:P156'], locale);
  const subject = {
    id: id(1),
    context: id(4),
    type: 'schema:Book',
    revision: 1,
    release: recorded.digest,
    labels: { en: 'Source work' },
    statements: {},
  } as unknown as Subject;
  const base = { property, status: 200, valid: true, complete: true, limit: 8 };
  const windows: ProfileRelationWindow[] = [
    {
      ...base,
      node: 'follows',
      direction: 'forward',
      rows: [
        { target: id(2), statement: assertion(10), summary, related: {} },
        { target: id(2), statement: assertion(11, false, true), summary, related: {} },
      ],
      complete: false,
      next: 'native-continuation',
    },
    {
      ...base,
      node: 'followed',
      direction: 'inverse',
      rows: [{ subject: id(2), property, statement: id(12), assertion: assertion(12, true), summary, related: {} }],
    },
    { ...base, node: 'empty', property: 'wdt:P156', direction: 'forward', rows: [] },
    { ...base, node: 'unavailable', property: 'wdt:P144', direction: 'forward', status: 503, rows: [] },
  ];
  const value = {
    locale,
    subject: id(1),
    subjectLabel: 'Source work',
    link: PlainLink,
    reader: { spoilerLevel: 0, suitability: 'show' },
    labels: { cover: {}, spoilerHide: 'Hide' },
    unlabelled: 'Unlabelled',
    spoilerShow: 'Reveal',
    relations: definitions,
    sections: new Map(),
    candidatePropertyLabel: (property: string) => {
      const properties = recorded.release.properties as Record<string, { labels: Record<string, string> }>;
      return pickText(properties[property]?.labels ?? {}, locale).text;
    },
  } as unknown as OverviewValue;
  return (
    <PatternStory path={route} visitor="Signed Out">
      <AppShell>
        <main className="mx-auto max-w-5xl space-y-6 p-4 sm:p-8">
          <h1 className="text-3xl font-semibold">Source work</h1>
          <OverviewContext.Provider value={value}>
            <WorkFranchiseOverview
              subject={subject}
              related={{}}
              definitions={definitions}
              locale={locale}
              returnTo={route}
              windows={windows}
            />
          </OverviewContext.Provider>
        </main>
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Subjects/Work franchise groups',
  component: GroupedWorkStory,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Illustrative admitted window shapes with recorded release labels: two directions, repeated target assertions, spoiler, empty, unavailable and continuation. No native execution is claimed.',
      },
    },
  },
} satisfies Meta<typeof GroupedWorkStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const DirectionsAndReadingStates: Story = {};
