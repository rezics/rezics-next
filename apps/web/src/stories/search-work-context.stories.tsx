import type { Meta, StoryObj } from '@storybook/react-vite';
import { bundledRelease } from '@rezics/definitions/bundled';
import { expect, within } from 'storybook/test';
import { getLocale } from '../paraglide/runtime.js';
import { DiscoveryResults } from '../search/discovery-results';
import type { DiscoveryHit, DiscoveryState } from '../search/discovery';
import type { Fact } from '../search/results';

function work(index: number, type: string, property?: string): DiscoveryHit {
  const id = `00000000-0000-4000-8000-00000000009${index}`;
  const date: Fact = { kind: 'time', year: 2000 + index, ...(index === 2 ? { month: 2 } : {}) };
  return {
    key: { owner: 'semantic', kind: type, route: 0, id },
    summary: {
      kind: 'subject',
      value: {
        id,
        type,
        types: [type],
        label: { value: 'Echo', language: 'en' },
        creativeWork: true,
        cover: null,
      },
    },
    labels: { en: 'Echo', ja: 'こだま' },
    aliases: { en: ['An echo across the valley'] },
    descriptions: { en: 'A same-title catalogue identity. Only the supplied facts belong to this result.' },
    ...(property
      ? {
          facts: {
            [property]: [
              {
                kind: 'item',
                id: `00000000-0000-4000-8000-00000000008${index}`,
                labels: {
                  en: index === 1 ? 'Mira Chen' : 'Robin Lee',
                  ja: index === 1 ? 'ミラ・チェン' : 'ロビン・リー',
                },
              },
            ],
            'schema:datePublished': [date],
          },
          listPresentation: { imageAspect: 'portrait', keyFacts: [property, 'schema:datePublished'] },
        }
      : {}),
  };
}

const homonyms: DiscoveryState = {
  status: 'ready',
  page: {
    hits: [
      work(1, 'schema:Book', 'schema:author'),
      work(2, 'schema:Book', 'schema:contributor'),
      work(3, 'schema:Movie', 'schema:director'),
      work(4, 'bf:Instance', 'schema:publisher'),
    ],
    kinds: {
      values: ['schema:Book', 'schema:Movie', 'bf:Instance'].map((id) => ({
        id,
        labels: bundledRelease.types[id]?.labels ?? {},
        icon: 'book',
      })),
      next: null,
    },
    next: 'native-next',
    as_of: '2026-11-04T00:00:00Z',
  },
};

function Example({ state, metadata = true }: { state: DiscoveryState; metadata?: boolean }) {
  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <DiscoveryResults
        state={state}
        locale={getLocale()}
        yearProperties={['schema:datePublished']}
        factDefinitions={metadata ? bundledRelease.properties : undefined}
      />
    </div>
  );
}

const meta = {
  title: 'Discovery/Search/Work context',
  id: 'patterns-search-work-context',
  component: Example,
  args: { state: homonyms },
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Homonyms: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('heading', { level: 2 })).toHaveLength(4);
    const creators = canvasElement.querySelectorAll('[data-property] a');
    await expect(creators).toHaveLength(4);
    await expect(creators[0]).toHaveAttribute('href', expect.stringContaining(`/${getLocale()}/subjects/`));
    await expect(canvasElement.querySelectorAll('[data-slot="year"]')).toHaveLength(3);
    await expect(canvasElement.querySelectorAll('[data-slot="date"]')).toHaveLength(1);
  },
};
export const MissingFacts: Story = {
  args: {
    state: {
      status: 'ready',
      page: {
        ...homonyms.page,
        hits: [work(5, 'schema:Book'), work(6, 'schema:Movie')],
        next: null,
      },
    },
  },
};
export const UnavailableMetadata: Story = { args: { metadata: false } };
