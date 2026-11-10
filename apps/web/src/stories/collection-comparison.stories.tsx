import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, within } from 'storybook/test';
import { PatternStory } from './page';
import { CollectionPage } from '../library/collection-page';
import type { EditableCollectionPage } from '../library/collection-load';
import type { CollectionMember } from '../library/reads';
import { parseListPresentation } from '@rezics/ui/cover';
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
    <PatternStory visitor="Signed Out" path={reference ? reference.href : `${source}&layout=${layout}`}>
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
            layout={layout}
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
  const { userEvent } = await import('storybook/test');
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: 'Recover same cursor' }));
  await expect(await canvas.findByText('Read this occurrence first.')).toBeVisible();
  await expect(await canvas.findByText('Revisit this occurrence later.')).toBeVisible();
  const links = canvasElement.querySelectorAll<HTMLAnchorElement>('[data-comparison-reference]');
  await expect(links).toHaveLength(2);
  await expect(links[0]!.href).not.toBe(links[1]!.href);
  await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth + 1);
}
export const Phone390: Story = {
  globals: { viewport: { value: 'phone390' }, theme: 'light' },
  render: () => <Example />,
  play: async ({ canvasElement }) => recoverExample(canvasElement),
};
export const Desktop1280: Story = {
  globals: { viewport: { value: 'desktop1280' }, theme: 'dark' },
  render: () => <Example layout="grid" />,
  play: async ({ canvasElement }) => recoverExample(canvasElement),
};
export const MissingDefinitionLabels: Story = {
  render: () => <Example unavailable />,
  play: async ({ canvasElement }) => recoverExample(canvasElement),
};

export const ReplacementDuringReferenceVisit: Story = {
  render: () => <Example />,
  play: async ({ canvasElement }) => {
    const { userEvent } = await import('storybook/test');
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
