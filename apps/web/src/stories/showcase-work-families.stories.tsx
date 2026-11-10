import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { pickText } from '@rezics/composition';
import recorded from '../kernel/recorded/definitions-release.json';
import { relationDefinitions } from '../subject/relations';
import type { Related, Subject } from '../subject/types';
import { OverviewContext, type OverviewValue } from '../features/pages/overview';
import { PlainLink } from '../features/pages/shared';
import { WorkFranchiseOverview } from '../features/pages/showcase-work/overview';
import type { ProfileRelationWindow } from '../features/pages/views';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const bookGirl = id(499);
const kara = id(2815);
const volumeGirl = id(5329);
const volumeKara = id(10862);
const anime = id(233);
const episode = id(10);
const voice = id(11);
const director = id(12);
const publisherGirl = id(13);
const publisherKara = id(14);
const properties = [
  'wdt:P179',
  'schema:publisher',
  'rezics:crossMediaCounterpart',
  'schema:isPartOf',
  'wdt:P725',
  'schema:director',
] as const;

type Statement = Subject['statements'][string][number];

function citation(subject: number): Statement['references'][number] {
  return {
    hash: `bgm.tv/subject/${subject}`,
    parts: [
      {
        property: { id: 'schema:url', data_type: 'url' },
        value: { type: 'value', content: `https://bgm.tv/subject/${subject}` },
      },
    ],
  };
}

function assertion(property: string, target: string, n: number, subject: number): Statement {
  return {
    id: id(n),
    rank: 'normal',
    property: { id: property, data_type: 'wikibase-item' },
    value: { type: 'value', content: target },
    qualifiers: [],
    references: [citation(subject)],
    rezics: { revision: 1, release: recorded.digest },
  };
}

function summary(target: string, type: string, language: string, value: string, aliases?: Record<string, string[]>) {
  return { id: target, type, types: [type], label: { language, value }, cover: null, ...(aliases ? { aliases } : {}) };
}

function windowFor(
  node: string,
  property: string,
  direction: 'forward' | 'inverse',
  rows: unknown[],
): ProfileRelationWindow {
  return { node, property, direction, rows, status: 200, valid: true, complete: true, limit: 3 };
}

function work(
  subjectId: string,
  type: string,
  labels: Record<string, string>,
  aliases: Record<string, string[]>,
  statements: Subject['statements'],
): Subject {
  return {
    id: subjectId,
    context: id(1),
    type,
    revision: 1,
    release: recorded.digest,
    labels,
    aliases,
    statements,
  } as unknown as Subject;
}

function FamiliesJourney() {
  const locale = getLocale();
  const definitions = relationDefinitions(recorded.release, properties, locale);
  const related = {
    [volumeGirl]: { type: 'schema:Book', types: ['schema:Book'], labels: { und: '“文学少女”と死にたがりの道化' } },
    [volumeKara]: { type: 'schema:Book', types: ['schema:Book'], labels: { und: '空の境界' } },
    [publisherGirl]: {
      type: 'schema:Organization',
      types: ['schema:Organization'],
      labels: { und: 'エンターブレイン' },
    },
    [publisherKara]: { type: 'schema:Organization', types: ['schema:Organization'], labels: { und: '講談社' } },
    [anime]: { type: 'schema:TVSeries', types: ['schema:TVSeries'], labels: { und: '空の境界' } },
    [kara]: { type: 'schema:BookSeries', types: ['schema:BookSeries'], labels: { und: '空の境界' } },
    [episode]: { type: 'schema:Episode', types: ['schema:Episode'], labels: { ja: '俯瞰風景' } },
    [voice]: { type: 'schema:Person', types: ['schema:Person'], labels: { und: '前田愛' } },
    [director]: { type: 'schema:Person', types: ['schema:Person'], labels: { und: 'あおきえい' } },
  } as unknown as Related;
  const bookGirlWork = work(
    bookGirl,
    'schema:BookSeries',
    { und: '文学少女', ja: '“文学少女”シリーズ' },
    { und: ['文学少女'] },
    {
      'schema:publisher': [assertion('schema:publisher', publisherGirl, 20, 499)],
      'wdt:P179': [assertion('wdt:P179', volumeGirl, 21, 499)],
    },
  );
  const karaWork = work(
    kara,
    'schema:BookSeries',
    { und: '空の境界', ja: '空の境界' },
    { und: ['空の境界'] },
    {
      'schema:publisher': [assertion('schema:publisher', publisherKara, 30, 2815)],
      'wdt:P179': [assertion('wdt:P179', volumeKara, 31, 2815)],
    },
  );
  const animeWork = work(
    anime,
    'schema:TVSeries',
    { und: '空の境界', ja: '空の境界' },
    { und: ['空の境界'] },
    {
      'wdt:P725': [assertion('wdt:P725', voice, 40, 233)],
      'schema:director': [assertion('schema:director', director, 41, 233)],
      'rezics:crossMediaCounterpart': [assertion('rezics:crossMediaCounterpart', kara, 42, 233)],
    },
  );
  const bookGirlWindows: ProfileRelationWindow[] = [
    windowFor('series-works', 'wdt:P179', 'inverse', [
      {
        subject: volumeGirl,
        property: 'wdt:P179',
        statement: id(21),
        assertion: assertion('wdt:P179', bookGirl, 21, 5329),
        summary: summary(volumeGirl, 'schema:Book', 'und', '“文学少女”と死にたがりの道化'),
        related: {},
      },
    ]),
  ];
  const karaWindows: ProfileRelationWindow[] = [
    windowFor('series-works', 'wdt:P179', 'inverse', [
      {
        subject: volumeKara,
        property: 'wdt:P179',
        statement: id(31),
        assertion: assertion('wdt:P179', kara, 31, 10862),
        summary: summary(volumeKara, 'schema:Book', 'und', '空の境界'),
        related: {},
      },
    ]),
    windowFor('counterparts', 'rezics:crossMediaCounterpart', 'inverse', [
      {
        subject: anime,
        property: 'rezics:crossMediaCounterpart',
        statement: id(42),
        assertion: assertion('rezics:crossMediaCounterpart', kara, 42, 233),
        summary: summary(anime, 'schema:TVSeries', 'und', '空の境界'),
        related: {},
      },
    ]),
  ];
  const animeWindows: ProfileRelationWindow[] = [
    windowFor('parts', 'schema:isPartOf', 'inverse', [
      {
        subject: episode,
        property: 'schema:isPartOf',
        statement: id(50),
        assertion: assertion('schema:isPartOf', anime, 50, 233),
        summary: summary(episode, 'schema:Episode', 'ja', '俯瞰風景'),
        related: {},
      },
    ]),
  ];
  const value = {
    locale,
    subject: bookGirl,
    subjectLabel: '文学少女',
    link: PlainLink,
    reader: { spoilerLevel: 0, suitability: 'show' },
    labels: { cover: {}, spoilerHide: 'Hide' },
    unlabelled: 'Unlabelled',
    spoilerShow: 'Reveal',
    relations: definitions,
    sections: new Map(),
    candidatePropertyLabel: (property: string) => {
      const released = recorded.release.properties as Record<string, { labels: Record<string, string> }>;
      return pickText(released[property]?.labels ?? {}, locale).text;
    },
  } as unknown as OverviewValue;
  const route = `/${locale}/subjects/${bookGirl}/bungaku-shoujo`;
  const overview = (subject: Subject, windows: ProfileRelationWindow[], label: string, returnTo: string) => (
    <OverviewContext.Provider value={{ ...value, subject: subject.id, subjectLabel: label }}>
      <WorkFranchiseOverview
        subject={subject}
        related={related}
        definitions={definitions}
        locale={locale}
        returnTo={returnTo}
        windows={windows}
      />
    </OverviewContext.Provider>
  );
  return (
    <PatternStory path={route} visitor="Signed Out">
      <AppShell>
        <main className="mx-auto max-w-5xl space-y-8 p-4 sm:p-8">
          <section className="space-y-2">
            <h1 className="text-3xl font-semibold" lang="und">
              文学少女
            </h1>
            {overview(bookGirlWork, bookGirlWindows, '文学少女', route)}
          </section>
          <section className="space-y-2">
            <h1 className="text-3xl font-semibold" lang="und">
              空の境界
            </h1>
            {overview(karaWork, karaWindows, '空の境界', `/${locale}/subjects/${kara}/kara-no-kyoukai`)}
          </section>
          <section className="space-y-2">
            <h1 className="text-3xl font-semibold" lang="und">
              空の境界
            </h1>
            {overview(animeWork, animeWindows, '空の境界', `/${locale}/subjects/${anime}/kara-no-kyoukai-anime`)}
          </section>
        </main>
      </AppShell>
    </PatternStory>
  );
}

async function expectFamilies(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await canvas.findAllByText('文学少女');
  await canvas.findAllByText('空の境界');
  expect(canvas.getByText('“文学少女”と死にたがりの道化')).toBeTruthy();
  expect(canvas.getByText('エンターブレイン')).toBeTruthy();
  expect(canvas.getByText('講談社')).toBeTruthy();
  expect(canvas.getByText('俯瞰風景')).toBeTruthy();
  expect(canvas.getByText('前田愛')).toBeTruthy();
  expect(canvas.getByText('あおきえい')).toBeTruthy();
  const why = await canvas.findAllByText(m.value_why({}, { locale: getLocale() as never }));
  await userEvent.click(why[0]!);
  expect(canvasElement.textContent).toContain('https://bgm.tv/subject/');
}

const meta = {
  title: 'Subjects/Showcase work families',
  id: 'pages-subjects-showcase-work-families',
  component: FamiliesJourney,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
    docs: {
      description: {
        component:
          'Illustrative authored Work overviews for Book Girl, Kara no Kyoukai and anime 233. Anonymous phone and desktop reading of volume, publisher, counterpart, episode, cast and staff targets with exact und aliases and citations. Constructed responses and synthetic identities; not recorded native execution or visual review.',
      },
    },
  },
} satisfies Meta<typeof FamiliesJourney>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WorkFamiliesReading: Story = {
  name: 'Default',
  globals: {},
  play: async ({ canvasElement }) => {
    await expectFamilies(canvasElement);
  },
};
