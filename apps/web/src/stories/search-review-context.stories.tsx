import type { Meta, StoryObj } from '@storybook/react-vite';
import { discoveryExample } from '../kernel/fake/search-discovery';
import { getLocale } from '../paraglide/runtime.js';
import type { DiscoveryPage } from '../search/discovery';
import { DiscoveryResults } from '../search/discovery-results';

const ids = ['00000000-0000-4000-8000-000000000911', '00000000-0000-4000-8000-000000000912'];
function page(withheld = false): DiscoveryPage {
  return {
    ...discoveryExample,
    hits: ids.map((id, index) => ({
      key: { owner: 'content', kind: 'review', route: 0, id },
      summary: {
        kind: 'review',
        value: {
          id,
          kind: 'review',
          title: 'Notes on the same title',
          author: { displayName: 'A reader', handle: null },
          excerpt: 'An observation from the published opening, with spoilers behind its reveal control.',
          source: { openingRevisionId: id, sourceVersion: 'native-example' },
          searchContext: {
            state: 'available',
            openingPostId: id,
            language: 'en',
            spoiler: true,
            target: withheld
              ? { state: 'withheld' }
              : {
                  state: 'available',
                  subject: {
                    id,
                    type: index ? 'schema:Movie' : 'schema:Book',
                    types: [index ? 'schema:Movie' : 'schema:Book'],
                    label: { value: 'Same title', language: 'en' },
                    creativeWork: true,
                    cover: null,
                  },
                },
            citation: withheld
              ? { state: 'withheld' }
              : {
                  state: 'available',
                  recorded: { questionId: '00000000-0000-7000-8000-000000000001', units: index ? 7 : 0, revision: 3 },
                  historicalQuestion: { state: 'unavailable' },
                },
          },
        },
      },
    })),
  };
}
function Example({ withheld }: { withheld: boolean }) {
  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <DiscoveryResults state={{ status: 'ready', page: page(withheld) }} locale={getLocale()} />
    </div>
  );
}
const meta = {
  title: 'Discovery/Review context',
  id: 'patterns-discovery-review-context',
  component: Example,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
  args: { withheld: false },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SameTitleHistoricalCitation: Story = {};
export const ConcealedTarget: Story = { args: { withheld: true } };
