import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LiteraryReaderEntry } from '../features/catalogue/literary-reader/entry';
import { literaryGrainExample, literaryIds, literaryStatement } from '../features/catalogue/literary-reader/examples';

const client = new QueryClient();

// The example factory widens the population kind to string; every grain example is the global population.
function grainExample(type?: 'schema:Book' | 'schema:BookSeries' | 'bf:Instance') {
  const population: { kind: 'global' } = { kind: 'global' };
  const example = literaryGrainExample(type);
  return { ...example, context: { ...example.context, population } };
}

const meta = {
  title: 'Pages/Subjects/Literary grain',
  component: LiteraryReaderEntry,
  args: grainExample(),
  decorators: [
    (Story) => (
      <QueryClientProvider client={client}>
        <div className="mx-auto max-w-5xl p-4">
          <Story />
        </div>
      </QueryClientProvider>
    ),
  ],
} satisfies Meta<typeof LiteraryReaderEntry>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Series: Story = {};
export const SeriesWithAnimeCounterpart: Story = { args: grainExample() };
export const Member: Story = { args: grainExample('schema:Book') };
export const Edition: Story = { args: grainExample('bf:Instance') };
const windowState = (status: number): Story => {
  const input = grainExample();
  return { args: { ...input, windows: [{ ...input.windows[0]!, status }] } };
};
export const Preparing: Story = windowState(202);
export const Withheld: Story = windowState(403);
export const Unavailable: Story = windowState(503);
const { next: _next, ...terminal } = literaryGrainExample().windows[0]!;
const { status: _status, ...loading } = literaryGrainExample().windows[0]!;
export const Empty: Story = {
  args: { windows: [{ ...terminal, rows: [], complete: true }] },
};
export const Unsupported: Story = { args: { descriptorState: 'unsupported', definitions: undefined } };
export const Loading: Story = { args: { windows: [loading] } };
export const LongJapanese: Story = {
  args: {
    ...grainExample('schema:Book'),
    locale: 'ja',
    work: {
      ...literaryGrainExample('schema:Book').work,
      labels: { ja: '港の物語・遥かなる海を渡る人々と終わることのない旅の記録'.repeat(4) },
    },
  },
};
export const TraditionalChinese: Story = {
  args: {
    ...grainExample('schema:Book'),
    locale: 'zh-Hant',
    work: {
      ...literaryGrainExample('schema:Book').work,
      labels: { 'zh-Hant': '海港的故事：在漫長的旅途中記錄人們與城市變遷的小說'.repeat(4) },
    },
  },
};
const multipleStreams = () => {
  const input = grainExample();
  const member = input.windows[0]!;
  const assertion = literaryStatement('schema:exampleOfWork', literaryIds.series);
  return {
    ...input,
    windows: [
      member,
      { ...member, node: 'members-secondary' },
      {
        ...member,
        node: 'editions-supplied',
        property: 'schema:exampleOfWork',
        direction: 'inverse' as const,
        rows: [
          {
            subject: literaryIds.edition,
            property: 'schema:exampleOfWork',
            statement: assertion.id,
            assertion,
            label: 'Harbour edition',
            type: 'bf:Instance',
            related: {},
            summary: {
              id: literaryIds.edition,
              type: 'bf:Instance',
              label: { value: 'Harbour edition', language: 'en' },
            },
          },
        ],
      },
    ],
  };
};
export const MultipleStreams: Story = { args: multipleStreams() };
