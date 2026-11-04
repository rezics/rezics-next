import { useEffect, useRef, type ComponentProps } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LiteraryReaderEntry } from '../features/catalogue/literary-reader/entry';
import {
  literaryGrainExample,
  literaryIds,
} from '../features/catalogue/literary-reader/examples';

const client = new QueryClient();
const realm = '0192f3a0-6c1e-7b2a-9d4e-000000000941';
const realmContext = '0192f3a0-6c1e-7b2a-9d4e-000000000942';
const context = { id: realmContext, population: { kind: 'realm' as const, id: realm, title: 'Harbour shelf' } };

function Addressed({ args, search = '' }: { args: ComponentProps<typeof LiteraryReaderEntry>; search?: string }) {
  const original = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    original.current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${search}${window.location.hash}`);
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

const meta = {
  title: 'Pages/Subjects/Literary grain visit',
  component: LiteraryReaderEntry,
  args: literaryGrainExample(),
  render: (args) => <Addressed args={args} />,
} satisfies Meta<typeof LiteraryReaderEntry>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SeriesAndVolume: Story = {};
export const VolumeAndEdition: Story = { args: literaryGrainExample('schema:Book') };
export const PhoneLight: Story = { ...SeriesAndVolume, globals: { viewport: { value: 'phone390' }, theme: 'light' } };
export const PhoneDark: Story = { ...SeriesAndVolume, globals: { viewport: { value: 'phone390' }, theme: 'dark' } };
export const DesktopLight: Story = {
  ...SeriesAndVolume,
  globals: { viewport: { value: 'desktop1440' }, theme: 'light' },
};
export const DesktopDark: Story = {
  ...SeriesAndVolume,
  globals: { viewport: { value: 'desktop1440' }, theme: 'dark' },
};

const concealed = literaryGrainExample();
const concealedWindow = concealed.windows[0]!;
const concealedRow = concealedWindow.rows[0]!;
export const SpoilerConcealed: Story = {
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

const book = literaryGrainExample('schema:Book');
export const EditionUnavailable: Story = {
  args: { ...book, windows: [{ ...book.windows[0]!, status: 503 }] },
};

const instance = literaryGrainExample('bf:Instance');
export const SourceSuppliedWorkOnly: Story = {
  args: {
    ...instance,
    work: { ...instance.work, statements: {} },
  },
};

const datedEdition = literaryGrainExample('bf:Instance');
export const PartialPublicationDate: Story = {
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

const longLabels = literaryGrainExample();
export const LongNamesAndJapaneseLabels: Story = {
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
      rows: window.rows.map((row) => ({
        ...row,
        summary: { ...row.summary, label: { value: '港の物語とそこに暮らした人々の長い記録'.repeat(5), language: 'ja' } },
      })),
    })),
  },
  globals: { viewport: { value: 'phone390' }, theme: 'dark', locale: 'ja' },
};

export const ContextRoundTrip: Story = {
  args: { ...literaryGrainExample(), context, realm },
  render: (args) => <Addressed args={args} search={`?realm=${realm}&context=${realmContext}`} />,
};

const current = literaryGrainExample();
const history = [
  { view: 'overview' },
  { view: 'contents', node: 'members', cursor: 'native/opaque?cursor=previous' },
];
export const CurrentPrevious: Story = {
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
  args: {
    ...removed,
    context,
    realm,
    view: 'contents',
    windows: [{ ...removed.windows[0]!, rows: [] }],
  },
  render: (args) => (
    <Addressed args={args} search={`?realm=${realm}&context=${realmContext}&focus=members%3Aremoved-statement`} />
  ),
};

export const RetiredContext: Story = {
  args: { ...literaryGrainExample(), context, realm },
  render: (args) => (
    <Addressed args={args} search={`?realm=${realm}&context=0192f3a0-6c1e-7b2a-9d4e-000000000949`} />
  ),
};

const independent = literaryGrainExample('schema:Book');
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
        label: { value: 'Harbour series', language: 'en' },
      },
      related: { [literaryIds.series]: independent.related[literaryIds.series]! },
    },
  ],
};
export const IndependentStreamRetry: Story = {
  args: {
    ...independent,
    windows: [{ ...memberWindow, status: 503 }, independent.windows[0]!],
  },
};
