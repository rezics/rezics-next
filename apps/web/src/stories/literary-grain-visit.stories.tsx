import { useCallback, useEffect, useRef, type ComponentProps } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LiteraryReaderEntry } from '../features/catalogue/literary-reader/entry';
import { literaryGrainExample, literaryGrainRow, literaryIds } from '../features/catalogue/literary-reader/examples';
import { book, bookEditions, bookSeries, bookSummary } from '../kernel/fixtures/book-showcase';
import { prepareBookShowcase, type BookScenario } from '../kernel/fake/book-showcase';
import { getLocale } from '../paraglide/runtime';
import { subjectViewHref } from '../subject/subject-href';
import { PageStory } from './page';

const client = new QueryClient();
const realm = '0192f3a0-6c1e-7b2a-9d4e-000000000941';
const realmContext = '0192f3a0-6c1e-7b2a-9d4e-000000000942';
const context = { id: realmContext, population: { kind: 'realm' as const, id: realm, title: 'Harbour shelf' } };

// The example factory widens the population kind to string; every grain example is the global population.
function grainExample(type?: 'schema:Book' | 'schema:BookSeries' | 'bf:Instance') {
  const population: { kind: 'global' } = { kind: 'global' };
  const example = literaryGrainExample(type);
  return {
    ...example,
    view: type === 'schema:Book' ? 'editions' : type === 'bf:Instance' ? 'overview' : 'contents',
    context: { ...example.context, population },
  };
}

function Addressed({ args, search = '' }: { args: ComponentProps<typeof LiteraryReaderEntry>; search?: string }) {
  const original = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    original.current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${search}${window.location.hash}`,
    );
    window.dispatchEvent(new PopStateEvent('popstate'));
    return () => {
      if (original.current) window.history.replaceState(window.history.state, '', original.current);
    };
  }, [search]);
  return (
    <QueryClientProvider client={client}>
      <div className="mx-auto max-w-5xl p-4">
        <LiteraryReaderEntry {...args} />
      </div>
    </QueryClientProvider>
  );
}

/** The ordinary Subject route supplies the frame, tabs, synopsis, reviews and current reader. */
function LiteraryVisit({
  subject,
  view,
  state = 'rich',
}: {
  subject: 'series' | 'work' | 'edition';
  view: 'overview' | 'contents' | 'editions';
  state?: BookScenario;
}) {
  const locale = getLocale();
  const prepareFixture = useCallback(() => prepareBookShowcase(state), [state]);
  const id = subject === 'series' ? bookSeries.id : subject === 'edition' ? bookEditions[2]!.id : book.id;
  const label = bookSummary(id, locale).label.value;
  return (
    <PageStory
      previewNewTabs
      visitor="Signed In"
      path={subjectViewHref({ id, label }, locale, view)}
      prepareFixture={prepareFixture}
      ratingsFixture="subject-ratings-global"
    />
  );
}

const meta = {
  title: 'Catalogue/Literary reader/Visit',
  id: 'pages-subjects-literary-grain-visit',
  component: LiteraryReaderEntry,
  args: grainExample(),
  render: (args) => <Addressed args={args} />,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The main visits use the ordinary Subject route, shell and literary reader with the invented Book showcase bibliography. Its titles, volumes, editions, reviews and native-format windows are synthetic examples, not provider recordings or native acceptance. Open a supplied row and return to its exact reading; tabs deliberately change views. The remaining Reader states mount the same LiteraryReaderEntry with labelled synthetic finite windows to isolate disclosure, partial dates, independent stream failure and return recovery. Runtime and browser review are deferred.',
      },
    },
  },
} satisfies Meta<typeof LiteraryReaderEntry>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SeriesAndVolume: Story = {
  render: () => <LiteraryVisit subject="series" view="contents" />,
  parameters: { controls: { disable: true } },
};
export const VolumeAndEdition: Story = {
  render: () => <LiteraryVisit subject="work" view="editions" />,
  parameters: { controls: { disable: true } },
};
export const EditionAndWork: Story = {
  render: () => <LiteraryVisit subject="edition" view="overview" />,
  parameters: { controls: { disable: true } },
};

const concealed = grainExample();
const concealedWindow = concealed.windows[0]!;
const concealedRow = literaryGrainRow(concealedWindow.rows[0]);
export const SpoilerConcealed: Story = {
  name: 'Reader · Spoiler concealed',
  args: {
    ...concealed,
    windows: [
      {
        ...concealedWindow,
        rows: [
          {
            ...concealedRow,
            assertion: {
              ...concealedRow.assertion,
              qualifiers: [
                {
                  property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
                  value: { type: 'value', content: { amount: '+2', unit: '1' } },
                },
              ],
            },
          },
        ],
      },
    ],
  },
};

export const EditionUnavailable: Story = {
  render: () => <LiteraryVisit subject="work" view="editions" state="failure" />,
  parameters: { controls: { disable: true } },
};

const instance = grainExample('bf:Instance');
export const SourceSuppliedWorkOnly: Story = {
  name: 'Reader · Source supplied work only',
  args: {
    ...instance,
    work: { ...instance.work, statements: {} },
  },
};

const datedEdition = grainExample('bf:Instance');
export const PartialPublicationDate: Story = {
  name: 'Reader · Partial publication date',
  args: {
    ...datedEdition,
    work: {
      ...datedEdition.work,
      statements: {
        ...datedEdition.work.statements,
        'schema:datePublished': [
          {
            id: '0192f3a0-6c1e-7b2a-9d4e-000000000943',
            rank: 'normal',
            property: { id: 'schema:datePublished', data_type: 'time' },
            value: {
              type: 'value',
              content: {
                time: '+2003-00-00T00:00:00Z',
                precision: 9,
                calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
              },
            },
            qualifiers: [],
            references: [],
          } as never,
        ],
      },
    },
  },
};

const longLabels = grainExample();
export const LongNamesAndJapaneseLabels: Story = {
  name: 'Reader · Long names and Japanese labels',
  args: {
    ...longLabels,
    locale: 'ja',
    work: {
      ...longLabels.work,
      labels: {
        en: 'The harbour / the long collected history of a changing port town '.repeat(3),
        ja: '港の長い物語とそこで生きた人々の記録'.repeat(8),
        'zh-Hant': '港灣與沿岸居民世代相傳的漫長故事'.repeat(5),
      },
    },
    windows: longLabels.windows.map((window) => ({
      ...window,
      rows: window.rows.map((row) => {
        const grain = literaryGrainRow(row);
        return {
          ...grain,
          summary: {
            ...grain.summary,
            label: { value: '港の物語とそこに暮らした人々の長い記録'.repeat(5), language: 'ja' },
          },
        };
      }),
    })),
  },
  globals: { locale: 'ja' },
};

export const ContextRoundTrip: Story = {
  name: 'Reader · Context round trip',
  args: { ...literaryGrainExample(), context, realm },
  render: (args) => <Addressed args={args} search={`?realm=${realm}&context=${realmContext}`} />,
};

const current = literaryGrainExample();
const history = [{ view: 'overview' }, { view: 'contents', node: 'members', cursor: 'native/opaque?cursor=previous' }];
export const CurrentPrevious: Story = {
  name: 'Reader · Current and previous',
  args: {
    ...current,
    context,
    realm,
    view: 'contents',
    continuation: { node: 'members', cursor: 'native/opaque?cursor=current' },
  },
  render: (args) => (
    <Addressed
      args={args}
      search={`?realm=${realm}&context=${realmContext}&node=members&cursor=native%2Fopaque%3Fcursor%3Dcurrent&focus=members%3Astatement-wdt%3AP179-series&history=${encodeURIComponent(JSON.stringify(history))}`}
    />
  ),
};

const removed = literaryGrainExample();
export const RemovedVolumeOnReturn: Story = {
  name: 'Reader · Removed volume on return',
  args: {
    ...removed,
    context,
    realm,
    view: 'contents',
    windows: [{ ...removed.windows[0]!, rows: [] }],
  },
  parameters: {
    docs: {
      codePanel: true,
      source: { code: '<Addressed args={args} />' },
    },
  },
  render: (args) => (
    <Addressed args={args} search={`?realm=${realm}&context=${realmContext}&focus=members%3Aremoved-statement`} />
  ),
};

export const RetiredContext: Story = {
  name: 'Reader · Retired context',
  args: { ...literaryGrainExample(), context, realm },
  render: (args) => <Addressed args={args} search={`?realm=${realm}&context=0192f3a0-6c1e-7b2a-9d4e-000000000949`} />,
};

const independent = grainExample('schema:Book');
const memberStatement = independent.work.statements['wdt:P179']![0]!;
const memberWindow = {
  ...independent.windows[0]!,
  node: 'members',
  property: 'wdt:P179',
  direction: 'forward' as const,
  rows: [
    {
      subject: independent.work.id,
      target: literaryIds.series,
      statement: memberStatement,
      summary: {
        id: literaryIds.series,
        type: 'schema:BookSeries',
        label: { value: 'Harbour stories', language: 'en' },
      },
      related: { [literaryIds.series]: independent.related[literaryIds.series]! },
    },
  ],
};
export const IndependentStreamRetry: Story = {
  name: 'Reader · Independent stream retry',
  args: {
    ...independent,
    view: 'contents',
    windows: [{ ...memberWindow, status: 503 }, independent.windows[0]!],
  },
};
