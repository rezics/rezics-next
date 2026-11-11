import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { PatternStory } from './page';
import { CollectionPage } from '../library/collection-page';
import type { EditableCollectionPage } from '../library/collection-load';
import type { CollectionMember } from '../library/reads';
import { parseListPresentation } from '@rezics/ui/cover';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { pickText } from '@rezics/composition';
import definitions from '../kernel/recorded/definitions-release.json';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const facts: NonNullable<CollectionMember['facts']> = {
  'schema:author': [{ kind: 'item', id: id(10), labels: { en: 'Same name', ja: '同名' } }],
  'schema:datePublished': [{ kind: 'time', year: 1943 }],
};
const members: CollectionMember[] = [
  ...[2, 3].map((n) => ({
    id: id(n),
    addedAt: '2026-10-01T00:00:00Z',
    note: n === 2 ? 'Read this occurrence first.' : 'Revisit this occurrence later.',
    subject: { id: id(4), type: 'schema:Book', types: ['schema:Book'], label: 'Identical title', cover: null },
    facts:
      n === 2
        ? facts
        : {
            ...facts,
            'schema:author': [{ kind: 'item' as const, id: id(11), labels: { en: 'Same name', ja: '同名' } }],
          },
  })),
  {
    id: id(5),
    addedAt: '2026-10-01T00:00:00Z',
    note: 'A supplied release, not an inferred edition.',
    subject: {
      id: id(6),
      type: 'rezics:AnimeRelease',
      types: ['rezics:AnimeRelease'],
      label: 'Identical title',
      cover: null,
    },
    facts: {
      'schema:datePublished': [{ kind: 'time', year: 2024, month: 2 }],
      'schema:director': [{ kind: 'item', id: '', labels: { en: 'Label without a destination' } }],
    },
  },
  { id: id(7), addedAt: '2026-10-01T00:00:00Z', note: null, subject: null },
];
const listPresentations = Object.fromEntries(
  ['schema:Book', 'rezics:AnimeRelease'].map((type) => [
    type,
    parseListPresentation(Object.entries(definitions.release.types).find(([id]) => id === type)?.[1].listPresentation)!,
  ]),
);
const source = `/collections/${id(1)}?cursor=same-page`;

function Example({ layout = 'list', unavailable = false }: { layout?: 'list' | 'grid'; unavailable?: boolean }) {
  const [layoutChoice, setLayoutChoice] = useState<{ initial: 'list' | 'grid'; value: 'list' | 'grid' }>();
  const view = layoutChoice?.initial === layout ? layoutChoice.value : layout;
  const [replaced, replace] = useState(false);
  const [recovered, recover] = useState(false);
  const [reference, visit] = useState<{ href: string; via: string } | null>(null);
  const locale = getLocale();
  const page: EditableCollectionPage = {
    id: id(1),
    title: replaced ? 'Replacement Collection' : 'Compare this Collection',
    description: null,
    visibility: null,
    disclosedVisibility: 'public',
    curator: null,
    revision: replaced ? 2 : 1,
    memberCount: null,
    firstPage: false,
    following: null,
    next: 'later-page',
    publicExport: false,
    memberState: recovered ? 'ready' : 'unavailable',
    cursor: 'same-page',
    updatedAt: '2026-10-01T00:00:00Z',
    members: replaced
      ? [{ ...members[0]!, id: id(91), facts: {} }]
      : members.map((member) => ({
          ...member,
          subject: member.subject
            ? {
                ...member.subject,
                typeLabel: pickText(
                  Object.entries(definitions.release.types).find(([id]) => id === member.subject?.type)?.[1].labels ??
                    {},
                  locale,
                ).text,
              }
            : null,
        })),
    listPresentations,
    comparisonDefinitions: unavailable ? {} : definitions.release.properties,
  };
  return (
    <PatternStory visitor="Signed Out" path={reference ? reference.href : `${source}&layout=${view}`}>
      <div
        className="mx-auto max-w-6xl space-y-4 p-4"
        onClickCapture={(event) => {
          const anchor = (event.target as Element).closest<HTMLAnchorElement>('[data-comparison-reference]');
          if (!anchor) return;
          event.preventDefault();
          const url = new URL(anchor.href);
          visit({ href: `${url.pathname}${url.search}`, via: url.searchParams.get('via')! });
        }}
      >
        <div className="flex flex-wrap gap-4">
          <button type="button" className="min-h-11 underline" onClick={() => recover(true)}>
            Recover same cursor
          </button>
          <button type="button" className="min-h-11 underline" onClick={() => replace(true)}>
            Replace Collection during reference visit
          </button>
        </div>
        {reference ? (
          <section className="space-y-4">
            <h1 className="text-xl font-semibold">Supplied reference</h1>
            <a
              className="inline-flex min-h-11 items-center underline"
              href={reference.via}
              onClick={(event) => {
                event.preventDefault();
                visit(null);
              }}
            >
              Return to Collection
            </a>
          </section>
        ) : (
          <CollectionPage
            page={page}
            queryKey={['comparison-example', page.id, page.revision]}
            cursor="same-page"
            layout={view}
            onLayoutChange={(value) => setLayoutChoice({ initial: layout, value })}
            refreshPage={async () => page}
          />
        )}
      </div>
    </PatternStory>
  );
}

const meta = {
  title: 'Library/Collection comparison',
  id: 'pages-library-collection-comparison',
  component: Example,
  argTypes: { layout: { control: 'inline-radio', options: ['list', 'grid'] } },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Mounted CollectionPage with supplied FULL facts and released annotations. Recover the same bounded page, inspect identical labels with distinct IDs, then replace the Collection. Existing locale, viewport and theme globals apply. Authored examples do not establish an executed result.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
async function recoverExample(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const layout = await canvas.findByRole('combobox', { name: m.library_layout() });
  await userEvent.selectOptions(layout, 'list');
  await expect(layout).toHaveValue('list');
  await userEvent.selectOptions(layout, 'grid');
  await expect(layout).toHaveValue('grid');
  await userEvent.click(await canvas.findByRole('button', { name: 'Recover same cursor' }));
  const items = [...canvasElement.querySelectorAll<HTMLElement>('[data-slot="collection-member-card"]')];
  await expect(items).toHaveLength(4);
  const openers = items.map((item) => item.querySelector<HTMLButtonElement>('[data-collection-detail-opener]')!);
  const document = canvasElement.ownerDocument;
  const window = document.defaultView!;
  for (const [index, item] of items.entries()) {
    const opener = openers[index]!;
    opener.scrollIntoView({ block: 'center' });
    const bounds = opener.getBoundingClientRect();
    const itemBounds = item.getBoundingClientRect();
    await expect(bounds.width).toBeGreaterThanOrEqual(44);
    await expect(bounds.height).toBeGreaterThanOrEqual(44);
    await expect(bounds.top).toBeGreaterThanOrEqual(itemBounds.top - 1);
    await expect(bounds.bottom).toBeLessThanOrEqual(itemBounds.bottom + 1);
    const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    await expect(hit === opener || opener.contains(hit)).toBe(true);
  }
  const references: string[] = [];
  const referenceIds: string[] = [];
  for (const [index, note] of ['Read this occurrence first.', 'Revisit this occurrence later.'].entries()) {
    const opener = openers[index]!;
    opener.scrollIntoView({ block: 'center' });
    await userEvent.pointer([
      { keys: '[MouseLeft>]', target: opener },
      { keys: '[/MouseLeft]', target: opener },
    ]);
    const detail = canvasElement.querySelector<HTMLElement>('[data-slot="member-reading-detail"]')!;
    await expect(detail).toHaveFocus();
    await expect(await within(detail).findByText(note)).toBeVisible();
    const reference = detail.querySelector<HTMLAnchorElement>('[data-comparison-reference]')!;
    await expect(reference).toBeVisible();
    references.push(reference.href);
    referenceIds.push(reference.dataset.comparisonReference!);
    await expect(reference.dataset.comparisonReference).toBe(id(10 + index));
    await expect(
      detail.querySelector(`[data-copy-reference="${reference.dataset.comparisonReference}"]`),
    ).toBeVisible();
    await expect(
      canvasElement.querySelector('[data-slot="cover-card-actions-row"] [data-collection-member-id]'),
    ).toBeNull();
    await userEvent.click(within(detail).getByRole('button', { name: m.collection_reading_close() }));
    await expect(opener).toHaveFocus();
  }
  await expect(references[0]).not.toBe(references[1]);
  await expect(referenceIds).toEqual([id(10), id(11)]);
  const itemsBottom = Math.max(...items.map((item) => item.getBoundingClientRect().bottom + window.scrollY));
  const more = canvasElement.querySelector<HTMLAnchorElement>('a[href*="cursor=later-page"]')!;
  more.scrollIntoView({ block: 'center' });
  await expect(more.getBoundingClientRect().top + window.scrollY).toBeGreaterThanOrEqual(itemsBottom);
  await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth + 1);
}
export const RecoveredComparison: Story = {
  name: 'Compare a recovered collection',
  args: { layout: 'grid' },
  play: async ({ canvasElement }) => recoverExample(canvasElement),
};

export const MissingDefinitionLabels: Story = {
  render: () => <Example unavailable />,
  play: async ({ canvasElement }) => recoverExample(canvasElement),
};

export const ReplacementDuringReferenceVisit: Story = {
  render: () => <Example />,
  play: async ({ canvasElement }) => {
    await recoverExample(canvasElement);
    const canvas = within(canvasElement);
    await userEvent.click(canvasElement.querySelector<HTMLElement>('[data-comparison-reference]')!);
    await expect(await canvas.findByRole('heading', { name: 'Supplied reference' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Replace Collection during reference visit' }));
    await userEvent.click(canvas.getByRole('link', { name: 'Return to Collection' }));
    await expect(await canvas.findByRole('heading', { name: 'Replacement Collection' })).toBeVisible();
    await expect(canvasElement.querySelector('[data-comparison-reference], textarea, [role="checkbox"]')).toBeNull();
  },
};
