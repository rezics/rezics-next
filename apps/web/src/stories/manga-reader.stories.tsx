import { mangaSelectedAddress } from '../features/catalogue/manga-reader/navigation';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { defaultReader } from '../subject/reader';
import type { Subject } from '../subject/types';
import { MangaReader } from '../features/catalogue/manga-reader/view';
import type { ProfileRelationWindow } from '../features/pages/views';
import type { RelationDefinition } from '../subject/relations';
import { dateText } from '../features/pages/overview';

const seriesId = '0192f3a0-6c1e-7b2a-9d4e-000000000901';
const volumeId = '0192f3a0-6c1e-7b2a-9d4e-000000000902';
const secondVolumeId = '0192f3a0-6c1e-7b2a-9d4e-000000000903';
const chapterId = '0192f3a0-6c1e-7b2a-9d4e-000000000904';
const editionId = '0192f3a0-6c1e-7b2a-9d4e-000000000905';

const definitions: Record<string, RelationDefinition> = {
  'schema:isPartOf': { label: 'Volumes', forwardLabel: 'Part of', group: 'membership', symmetric: false },
  'bf:hasPart': { label: 'Contains', forwardLabel: 'Part of', group: 'membership', symmetric: false },
  'schema:workExample': { label: 'Work', forwardLabel: 'Edition', group: 'association', symmetric: false },
};

function inverseItem(
  id: string,
  label: string,
  property: string,
  statementId: string,
  type: string,
  position?: string,
) {
  return {
    subject: id,
    property,
    label,
    type,
    statement: statementId,
    assertion: {
      id: statementId,
      rank: 'normal',
      property: { id: property, data_type: 'wikibase-item' },
      value: { type: 'value', content: seriesId },
      qualifiers: position
        ? [{ property: { id: 'schema:position', data_type: 'string' }, value: { type: 'value', content: position } }]
        : [],
      references: [
        {
          hash: 'catalogue-source',
          parts: [
            {
              property: { id: 'schema:url', data_type: 'url' },
              value: { type: 'value', content: 'https://example.test/catalogue' },
            },
          ],
        },
        {
          hash: 'printed-source',
          parts: [
            {
              property: { id: 'schema:description', data_type: 'string' },
              value: { type: 'value', content: 'Printed contents page' },
            },
          ],
        },
      ],
      rezics: { release: 'current-release', revision: 1 },
    },
    summary: { id, type, label: { value: label, language: 'en' } },
    related: {},
  };
}

function forwardItem(target: string, label: string, property: string, statementId: string, type: string) {
  return {
    target,
    label,
    type,
    statement: {
      id: statementId,
      rank: 'normal',
      property: { id: property, data_type: 'wikibase-item' },
      value: { type: 'value', content: target },
      qualifiers: [],
      references: [],
      rezics: { release: 'current-release', revision: 1 },
    },
    summary: { id: target, type, label: { value: label, language: 'en' } },
    related: {},
  };
}

function window(
  node: string,
  property: string,
  direction: 'forward' | 'inverse',
  rows: readonly unknown[],
  options: { status?: number; next?: string; count?: ProfileRelationWindow['count']; valid?: boolean } = {},
): ProfileRelationWindow {
  return {
    node,
    property,
    direction,
    rows,
    status: options.status ?? 200,
    valid: options.valid ?? true,
    complete: options.next === undefined,
    ...(options.next ? { next: options.next } : {}),
    ...(options.count ? { count: options.count } : {}),
  };
}

const subject = (id: string, type: 'schema:ComicSeries' | 'schema:PublicationVolume', label: string) =>
  ({ id, type, labels: { en: label }, statements: {}, context: 'catalogue' }) as unknown as Subject;

const source = {};
const observation = (id: string, view = 'overview') => ({
  source,
  release: definitions,
  subject: id,
  context: 'catalogue',
  locale: 'en',
  viewer: null,
  view,
  window: null,
});
const recoveryHref = '/en/subjects/0192f3a0-6c1e-7b2a-9d4e-000000000901/example#manga-reader';

const meta = {
  title: 'Pages/Subjects/Manga reading',
  component: MangaReader,
  parameters: {
    docs: {
      description: {
        component:
          'Authored presentation examples only. These fixtures are not observed native responses and do not establish API, browser, or acceptance evidence.',
      },
    },
  },
} satisfies Meta<typeof MangaReader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SeriesWithVolumesAndGenericChapterRelation: Story = {
  args: {
    currentHref: mangaSelectedAddress(recoveryHref, {
      node: 'volumes',
      direction: 'inverse',
      property: 'schema:isPartOf',
      holder: volumeId,
      statement: 'assertion-volume-1',
      target: volumeId,
    }),
    subject: subject(seriesId, 'schema:ComicSeries', 'The Harbour Atlas'),
    locale: 'en',
    view: 'overview',
    definitions,
    reader: defaultReader,
    observation: observation(seriesId),
    recoveryHref,
    windows: [
      window(
        'volumes',
        'schema:isPartOf',
        'inverse',
        [
          inverseItem(volumeId, 'Volume 1', 'schema:isPartOf', 'assertion-volume-1', 'schema:PublicationVolume', '1'),
          inverseItem(
            secondVolumeId,
            'Volume 2',
            'schema:isPartOf',
            'assertion-volume-2',
            'schema:PublicationVolume',
            '2',
          ),
        ],
        { count: { value: 2, relation: 'exact' } },
      ),
      window('generic-parts', 'bf:hasPart', 'inverse', [
        inverseItem(chapterId, 'Harbour at Dawn', 'bf:hasPart', 'assertion-chapter-1', 'schema:CreativeWork', '01'),
      ]),
    ],
  },
};

export const ExactVolumeWithParentEditionAndPartialDate: Story = {
  args: {
    subject: subject(volumeId, 'schema:PublicationVolume', 'Volume 1'),
    locale: 'en',
    view: 'overview',
    definitions,
    reader: defaultReader,
    observation: observation(volumeId),
    recoveryHref,
    windows: [
      window('parent', 'schema:isPartOf', 'forward', [
        forwardItem(seriesId, 'The Harbour Atlas', 'schema:isPartOf', 'assertion-parent', 'schema:ComicSeries'),
      ]),
      window('editions', 'schema:workExample', 'forward', [
        forwardItem(editionId, 'First print', 'schema:workExample', 'assertion-edition', 'bf:Instance'),
      ]),
    ],
  },
  render: (args: ComponentProps<typeof MangaReader>) => (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Publication date: {dateText('2024-04', 'en')}</p>
      <MangaReader {...args} />
    </div>
  ),
};

export const UnsupportedSpecializedChapterConfiguration: Story = {
  args: {
    subject: subject(seriesId, 'schema:ComicSeries', 'The Harbour Atlas'),
    locale: 'en',
    view: 'overview',
    definitions,
    reader: defaultReader,
    observation: observation(seriesId, 'contents'),
    recoveryHref,
    windows: [],
  },
};

export const SparseContinuedEmptyWindow: Story = {
  args: {
    subject: subject(seriesId, 'schema:ComicSeries', 'The Harbour Atlas'),
    locale: 'en',
    view: 'contents',
    definitions,
    reader: defaultReader,
    observation: observation(seriesId, 'contents'),
    recoveryHref,
    windows: [
      window('parts', 'schema:isPartOf', 'inverse', [], {
        next: 'native:opaque-window',
        count: { value: 6, relation: 'lower_bound' },
      }),
    ],
  },
};

export const WithheldRelationWindow: Story = {
  args: {
    subject: subject(seriesId, 'schema:ComicSeries', 'The Harbour Atlas'),
    locale: 'en',
    view: 'contents',
    definitions,
    reader: defaultReader,
    observation: observation(seriesId, 'contents'),
    recoveryHref,
    windows: [window('parts', 'schema:isPartOf', 'inverse', [], { status: 403, valid: false })],
  },
};

export const UnavailableRelationWindow: Story = {
  args: {
    subject: subject(seriesId, 'schema:ComicSeries', 'The Harbour Atlas'),
    locale: 'en',
    view: 'contents',
    definitions,
    reader: defaultReader,
    observation: observation(seriesId),
    recoveryHref,
    windows: [window('parts', 'schema:isPartOf', 'inverse', [], { status: 503, valid: false })],
  },
};
