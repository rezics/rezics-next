import type { Meta, StoryObj } from '@storybook/react-vite';
import { bundledRelease } from '@rezics/definitions/bundled';
import { expect, within } from 'storybook/test';
import { getLocale } from '../paraglide/runtime.js';
import { DiscoveryResults } from '../search/discovery-results';
import type { DiscoveryHit, DiscoveryState } from '../search/discovery';
import type { Fact } from '../search/results';

const uuid = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = `sha256:${'0'.repeat(64)}`;

function term(id: string, label: string) {
  return { id, labels: { en: label, ja: label } };
}

function statement(
  sourceId: string,
  number: number,
  property: string,
  propertyLabel: string,
  value: unknown,
  qualifiers: unknown = { state: 'empty' },
) {
  return {
    statementId: uuid(number),
    sourceId,
    direction: 'outgoing',
    property: term(property, propertyLabel),
    revision: 1,
    release: digest,
    rank: 'normal',
    value,
    qualifiers,
  };
}

function context(index: number, id: string, type: string) {
  if (index === 6) return undefined;
  if (index === 7) return { state: 'unavailable', reason: 'native' };
  const kind = type === 'bf:Instance' ? 'release' : type === 'schema:MusicRecording' ? 'recording' : 'work';
  const creator = statement(
    id,
    700 + index,
    'schema:author',
    'Author',
    {
      state: 'value',
      kind: 'item',
      id: uuid(800 + index),
      originalId: uuid(900 + index),
      type: term('schema:Person', 'Person'),
      labels: { en: index === 1 ? 'Mira Chen' : 'Robin Lee', ja: index === 1 ? 'ミラ・チェン' : 'ロビン・リー' },
    },
    index === 1
      ? {
          state: 'current',
          items: [
            {
              property: term('schema:roleName', 'Credited as'),
              value: { state: 'value', kind: 'text', text: 'M. Chen' },
            },
          ],
        }
      : { state: 'empty' },
  );
  const relations = [1, 2, 3].map((offset) =>
    statement(id, 730 + index * 4 + offset, 'schema:partOf', 'Part of', {
      state: 'value',
      kind: 'item',
      id: uuid(1200 + index * 4 + offset),
      originalId: uuid(1300 + index * 4 + offset),
      type: term('schema:CreativeWork', 'Creative work'),
      labels: { en: `Series ${offset}`, ja: `シリーズ ${offset}` },
    }),
  );
  const date: Fact = { kind: 'time', year: 2000 + index, ...(index === 2 ? { month: 2 } : {}) };
  return {
    state: 'current',
    subjectId: id,
    type: term(type, type),
    kind,
    creators:
      index === 2
        ? { state: 'empty' }
        : index === 3
          ? { state: 'unavailable', reason: 'limit' }
          : { state: 'current', items: [creator], overflow: false },
    relations:
      index === 1
        ? { state: 'current', items: relations, overflow: true }
        : index === 2
          ? { state: 'withheld' }
          : index === 3
            ? { state: 'unsupported' }
            : { state: 'empty' },
    dates: {
      state: 'current',
      items: [
        statement(id, 720 + index, 'schema:datePublished', 'Publication date', {
          state: 'value',
          kind: 'time',
          calendar: 'gregorian',
          year: date.year,
          ...(date.month === undefined ? {} : { month: date.month }),
        }),
        ...(index === 1
          ? [
              statement(id, 740 + index, 'schema:datePublished', 'Publication date', { state: 'somevalue' }),
              statement(id, 750 + index, 'schema:datePublished', 'Publication date', { state: 'novalue' }),
            ]
          : index === 3
            ? [statement(id, 750 + index, 'schema:datePublished', 'Publication date', { state: 'unsupported' })]
            : []),
      ],
      overflow: false,
    },
  };
}

function work(index: number, type: string, property?: string): DiscoveryHit {
  const id = uuid(90 + index);
  const date: Fact = { kind: 'time', year: 2000 + index, ...(index === 2 ? { month: 2 } : {}) };
  const workContext = context(index, id, type);
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
    ...(workContext === undefined ? {} : { workContext }),
    ...(property
      ? {
          facts: {
            [property]: [
              {
                kind: 'item',
                id: uuid(800 + index),
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
  } as DiscoveryHit;
}

const homonyms: DiscoveryState = {
  status: 'ready',
  page: {
    hits: [
      work(1, 'schema:Book', 'schema:author'),
      work(2, 'schema:Book', 'schema:contributor'),
      work(3, 'schema:Movie', 'schema:director'),
      work(4, 'bf:Instance', 'schema:publisher'),
      work(5, 'schema:MusicRecording'),
    ],
    kinds: {
      values: ['schema:Book', 'schema:Movie', 'bf:Instance', 'schema:MusicRecording'].map((id) => ({
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
    await expect(canvas.getAllByRole('heading', { level: 2 })).toHaveLength(5);
    const creators = canvasElement.querySelectorAll('[data-property] a');
    await expect(creators).toHaveLength(4);
    await expect(creators[0]).toHaveAttribute('href', expect.stringContaining(`/${getLocale()}/subjects/`));
    await expect(canvasElement.querySelectorAll('[data-slot="year"]')).toHaveLength(3);
    await expect(canvasElement.querySelectorAll('[data-slot="date"]')).toHaveLength(1);
    await expect(canvasElement.querySelectorAll('[data-slot="discovery-work-context"]')).toHaveLength(5);
    await expect(canvasElement.querySelector('[data-kind="release"]')).not.toBeNull();
    await expect(canvasElement.querySelector('[data-kind="recording"]')).not.toBeNull();
    const overflow = canvasElement.querySelector('[data-work-context-overflow]');
    await expect(overflow).not.toBeNull();
    await expect(overflow?.querySelector('a')).toBeNull();
  },
};

export const MissingWorkContext: Story = {
  args: {
    state: {
      status: 'ready',
      page: {
        ...homonyms.page,
        hits: [work(6, 'schema:Book')],
        next: null,
      },
    },
  },
};

export const UnavailableWorkContext: Story = {
  args: {
    state: {
      status: 'ready',
      page: {
        ...homonyms.page,
        hits: [work(7, 'bf:Instance')],
        next: null,
      },
    },
  },
};

export const UnavailableMetadata: Story = { args: { metadata: false } };
