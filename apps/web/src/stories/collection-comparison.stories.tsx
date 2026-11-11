import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';
import { useLocation } from '@tanstack/react-router';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { PatternStory } from './page';
import { CollectionPage } from '../library/collection-page';
import type { EditableCollectionPage } from '../library/collection-load';
import type { CollectionMember } from '../library/reads';
import { collectionPageAddress } from '../library/collection-presentation';
import { collectionMemberReturnAddress } from '../subject/collection-return';
import { parseListPresentation } from '@rezics/ui/cover';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { pickText } from '@rezics/composition';
import definitions from '../kernel/recorded/definitions-release.json';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const referenceLabels = { en: 'Same name', ja: '同名' };
const facts: NonNullable<CollectionMember['facts']> = {
  'schema:author': [{ kind: 'item', id: id(10), labels: referenceLabels }],
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
            'schema:author': [{ kind: 'item' as const, id: id(11), labels: referenceLabels }],
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
function comparisonAddress(layout: 'list' | 'grid') {
  const locale = getLocale();
  const directory = `/${locale}/library/collections?cursor=comparison-directory&layout=rows`;
  return `${collectionPageAddress(locale, id(1), 'same-page', {}, layout)}&returnTo=${encodeURIComponent(directory)}`;
}

/** Observe the mounted router; the fixture's requested path alone does not establish a completed navigation. */
function ComparisonVisit({
  children,
  onReference,
}: {
  children: ReactNode;
  onReference: (reference: { href: string; via: string }) => void;
}) {
  const href = useLocation({ select: (location) => location.publicHref });
  return (
    <div
      data-comparison-location={href}
      className="mx-auto max-w-6xl space-y-4 p-4"
      onClickCapture={(event) => {
        const anchor = (event.target as Element).closest<HTMLAnchorElement>('[data-comparison-reference]');
        if (!anchor) return;
        event.preventDefault();
        const url = new URL(anchor.href);
        onReference({ href: `${url.pathname}${url.search}${url.hash}`, via: url.searchParams.get('via')! });
      }}
    >
      {children}
    </div>
  );
}

function Example({ layout = 'list', unavailable = false }: { layout?: 'list' | 'grid'; unavailable?: boolean }) {
  const [layoutChoice, setLayoutChoice] = useState<{ initial: 'list' | 'grid'; value: 'list' | 'grid' }>();
  const view = layoutChoice?.initial === layout ? layoutChoice.value : layout;
  const [replaced, replace] = useState(false);
  const [recovered, recover] = useState(false);
  const [reference, visit] = useState<{ href: string; via: string } | null>(null);
  const [returnedTo, returnTo] = useState<string>();
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
      ? [{ ...members[0]!, id: id(91), facts: {}, note: 'A new occurrence in the replacement Collection.' }]
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
    <PatternStory visitor="Signed Out" path={reference?.href ?? returnedTo ?? comparisonAddress(view)}>
      <ComparisonVisit onReference={visit}>
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
                returnTo(reference.via);
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
            onLayoutChange={(value) => {
              returnTo(undefined);
              setLayoutChoice({ initial: layout, value });
            }}
            refreshPage={async () => page}
          />
        )}
      </ComparisonVisit>
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
const occurrenceIds = members.map((member) => member.id);
const memberSelector = '[data-collection-members] > li, [data-slot="collection-member-card"]';

function mountedAddress(canvasElement: HTMLElement) {
  return canvasElement.querySelector<HTMLElement>('[data-comparison-location]')!.dataset.comparisonLocation!;
}

async function mountedPresentation(canvasElement: HTMLElement, layout: 'list' | 'grid', ids = occurrenceIds) {
  await waitFor(() => {
    const container = canvasElement.querySelector<HTMLElement>('[data-collection-members]')!;
    expect(container).toBeVisible();
    expect(container.dataset.collectionLayout).toBe(layout);
    expect(container.tagName).toBe(layout === 'list' ? 'UL' : 'DIV');
    const items = [...container.querySelectorAll<HTMLElement>(memberSelector)];
    expect(items.map((item) => item.dataset.collectionMemberId)).toEqual(ids);
    expect(container.querySelectorAll('[data-collection-detail-opener]')).toHaveLength(ids.length);
    expect(container.querySelectorAll('[data-slot="collection-member-card"]')).toHaveLength(
      layout === 'grid' ? ids.length : 0,
    );
    const currentControl = within(canvasElement).getByRole('combobox', { name: m.library_layout() });
    expect(currentControl.isConnected).toBe(true);
    expect(currentControl).toHaveValue(layout);
  });
}

async function selectPresentation(canvasElement: HTMLElement, layout: 'list' | 'grid') {
  // PatternStory replaces its routed subtree when the address changes. Never retain this control for the next choice.
  const currentControl = await within(canvasElement).findByRole('combobox', { name: m.library_layout() });
  await userEvent.selectOptions(currentControl, layout);
  await mountedPresentation(canvasElement, layout);
  await expect(mountedAddress(canvasElement)).toBe(comparisonAddress(layout));
}

function boundedWidth(canvasElement: HTMLElement) {
  expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth + 1);
}

async function inspectOccurrence(canvasElement: HTMLElement, occurrence: string) {
  const item = canvasElement.querySelector<HTMLElement>(
    `[data-collection-members] [data-collection-member-id="${occurrence}"]`,
  )!;
  const opener = item.querySelector<HTMLButtonElement>('[data-collection-detail-opener]')!;
  opener.scrollIntoView({ block: 'center' });
  await expect(opener.isConnected).toBe(true);
  const bounds = opener.getBoundingClientRect();
  const itemBounds = item.getBoundingClientRect();
  await expect(bounds.width).toBeGreaterThanOrEqual(44);
  await expect(bounds.height).toBeGreaterThanOrEqual(44);
  await expect(bounds.top).toBeGreaterThanOrEqual(itemBounds.top - 1);
  await expect(bounds.bottom).toBeLessThanOrEqual(itemBounds.bottom + 1);
  await expect(bounds.left).toBeGreaterThanOrEqual(itemBounds.left - 1);
  await expect(bounds.right).toBeLessThanOrEqual(itemBounds.right + 1);
  const hit = canvasElement.ownerDocument.elementFromPoint(
    bounds.left + bounds.width / 2,
    bounds.top + bounds.height / 2,
  );
  await expect(hit === opener || opener.contains(hit)).toBe(true);
  await userEvent.pointer([
    { keys: '[MouseLeft>]', target: opener },
    { keys: '[/MouseLeft]', target: opener },
  ]);
  const detail = await waitFor(() => {
    const current = canvasElement.querySelector<HTMLElement>('[data-slot="member-reading-detail"]')!;
    expect(current).toHaveFocus();
    expect(current.querySelector('[data-collection-member-id]')).toHaveAttribute(
      'data-collection-member-id',
      occurrence,
    );
    expect(opener).toHaveAttribute('aria-expanded', 'true');
    return current;
  });
  await expect(canvasElement.querySelectorAll('[data-slot="member-reading-detail"]')).toHaveLength(1);
  boundedWidth(canvasElement);
  return { opener, detail };
}

async function closeOccurrence(canvasElement: HTMLElement, opener: HTMLButtonElement, detail: HTMLElement) {
  await userEvent.click(within(detail).getByRole('button', { name: m.collection_reading_close() }));
  await waitFor(() => {
    expect(canvasElement.querySelector('[data-slot="member-reading-detail"]')).toBeNull();
    expect(opener).toHaveFocus();
    expect(opener).toHaveAttribute('aria-expanded', 'false');
  });
}

function exactReference(canvasElement: HTMLElement, detail: HTMLElement, index: number) {
  const reference = detail.querySelector<HTMLAnchorElement>('[data-comparison-reference]')!;
  expect(reference).toBeVisible();
  expect(reference.dataset.comparisonReference).toBe(id(10 + index));
  expect(reference.textContent).toBe(pickText(referenceLabels, getLocale()).text);
  const target = new URL(reference.href);
  expect(target.pathname).toContain(id(10 + index));
  const via = target.searchParams.get('via')!;
  expect(via).toBe(collectionMemberReturnAddress(mountedAddress(canvasElement), id(2 + index)));
  const coordinates = new URL(via, reference.ownerDocument.location.origin);
  expect(coordinates.pathname).toBe(`/${getLocale()}/collections/${id(1)}`);
  expect(coordinates.searchParams.get('cursor')).toBe('same-page');
  expect(coordinates.searchParams.get('layout')).toBe('grid');
  expect(coordinates.searchParams.get('returnTo')).toBe(
    `/${getLocale()}/library/collections?cursor=comparison-directory&layout=rows`,
  );
  expect(coordinates.hash).toBe(`#collection-member-${id(2 + index)}`);
  expect(detail.querySelector(`[data-copy-reference="${id(10 + index)}"]`)).toBeVisible();
  return { reference, via, href: `${target.pathname}${target.search}${target.hash}` };
}

async function departReference(canvasElement: HTMLElement, index: number) {
  // Recovery and prior inspection close the detail. A departure must open the current occurrence deliberately.
  const { opener, detail } = await inspectOccurrence(canvasElement, id(2 + index));
  const departure = exactReference(canvasElement, detail, index);
  await userEvent.click(departure.reference);
  await expect(await within(canvasElement).findByRole('heading', { name: 'Supplied reference' })).toBeVisible();
  await waitFor(() => expect(mountedAddress(canvasElement)).toBe(departure.href));
  await expect(detail.isConnected).toBe(false);
  await expect(opener.isConnected).toBe(false);
  const returnLink = within(canvasElement).getByRole('link', { name: 'Return to Collection' });
  await expect(returnLink).toHaveAttribute('href', departure.via);
  return departure;
}

async function returnToComparison(canvasElement: HTMLElement, via: string, replaced = false) {
  await userEvent.click(within(canvasElement).getByRole('link', { name: 'Return to Collection' }));
  await expect(
    await within(canvasElement).findByRole('heading', {
      name: replaced ? 'Replacement Collection' : 'Compare this Collection',
    }),
  ).toBeVisible();
  await mountedPresentation(canvasElement, 'grid', replaced ? [id(91)] : occurrenceIds);
  await expect(mountedAddress(canvasElement)).toBe(via);
  await expect(
    canvasElement.querySelector('[data-slot="member-reading-detail"], [data-comparison-reference]'),
  ).toBeNull();
  boundedWidth(canvasElement);
}

async function recoverExample(canvasElement: HTMLElement, missingDefinitions = false) {
  const canvas = within(canvasElement);
  await canvas.findByRole('combobox', { name: m.library_layout() });
  const beforeRecovery = mountedAddress(canvasElement);
  await expect(canvasElement.querySelectorAll('[data-collection-detail-opener]')).toHaveLength(0);
  await userEvent.click(canvas.getByRole('button', { name: 'Recover same cursor' }));
  await waitFor(() => expect(canvasElement.querySelectorAll('[data-collection-detail-opener]')).toHaveLength(4));
  await expect(mountedAddress(canvasElement)).toBe(beforeRecovery);
  // Establish actual recovered rows and cards, including when List is already the story's initial choice.
  await selectPresentation(canvasElement, 'list');
  await selectPresentation(canvasElement, 'grid');
  const references: string[] = [];
  const referenceIds: string[] = [];
  for (const [index, member] of members.entries()) {
    const { opener, detail } = await inspectOccurrence(canvasElement, member.id);
    if (member.note) await expect(await within(detail).findByText(member.note)).toBeVisible();
    else await expect(detail.querySelector('[data-slot="collection-member-note"]')).toBeNull();
    if (missingDefinitions && member.subject)
      await expect(detail.querySelector('dt')).toHaveTextContent(m.search_constraint_identity_property_unavailable());
    if (index < 2) {
      const { reference } = exactReference(canvasElement, detail, index);
      references.push(reference.href);
      referenceIds.push(reference.dataset.comparisonReference!);
    } else {
      await expect(detail.querySelector('[data-comparison-reference]')).toBeNull();
      if (member.subject) {
        await expect(within(detail).getByText('Label without a destination')).toBeVisible();
        await expect(within(detail).queryByRole('link', { name: 'Label without a destination' })).toBeNull();
      } else {
        await expect(within(detail).getByText(m.library_subject_unavailable())).toBeVisible();
        await expect(detail.querySelector('a, [data-copy-reference]')).toBeNull();
      }
    }
    await expect(
      canvasElement.querySelector('[data-slot="cover-card-actions-row"] [data-collection-member-id]'),
    ).toBeNull();
    await closeOccurrence(canvasElement, opener, detail);
  }
  await expect(references[0]).not.toBe(references[1]);
  await expect(referenceIds).toEqual([id(10), id(11)]);
  const window = canvasElement.ownerDocument.defaultView!;
  const items = [...canvasElement.querySelectorAll<HTMLElement>(memberSelector)];
  const itemsBottom = Math.max(...items.map((item) => item.getBoundingClientRect().bottom + window.scrollY));
  const more = canvasElement.querySelector<HTMLAnchorElement>('a[href*="cursor=later-page"]')!;
  more.scrollIntoView({ block: 'center' });
  await expect(more.getBoundingClientRect().top + window.scrollY).toBeGreaterThanOrEqual(itemsBottom);
  boundedWidth(canvasElement);
  const departure = await departReference(canvasElement, 0);
  await returnToComparison(canvasElement, departure.via);
}

export const RecoveredComparison: Story = {
  name: 'Compare a recovered collection',
  args: { layout: 'grid' },
  play: async ({ canvasElement }) => recoverExample(canvasElement),
};

export const MissingDefinitionLabels: Story = {
  render: () => <Example unavailable />,
  play: async ({ canvasElement }) => recoverExample(canvasElement, true),
};

export const ReplacementDuringReferenceVisit: Story = {
  render: () => <Example />,
  play: async ({ canvasElement }) => {
    await recoverExample(canvasElement);
    const departure = await departReference(canvasElement, 1);
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Replace Collection during reference visit' }));
    await expect(await canvas.findByRole('heading', { name: 'Supplied reference' })).toBeVisible();
    await expect(mountedAddress(canvasElement)).toBe(departure.href);
    await returnToComparison(canvasElement, departure.via, true);
    await expect(departure.reference.isConnected).toBe(false);
    await expect(canvasElement.querySelector('[data-comparison-reference], textarea, [role="checkbox"]')).toBeNull();
    const { opener, detail } = await inspectOccurrence(canvasElement, id(91));
    await expect(within(detail).getByText('A new occurrence in the replacement Collection.')).toBeVisible();
    for (const member of members) {
      await expect(canvasElement.querySelector(`[data-collection-member-id="${member.id}"]`)).toBeNull();
      if (member.note) await expect(within(detail).queryByText(member.note)).toBeNull();
    }
    await expect(detail.querySelector('[data-comparison-reference]')).toBeNull();
    for (const oldId of [id(10), id(11)])
      await expect(detail.querySelector(`[data-copy-reference="${oldId}"]`)).toBeNull();
    await closeOccurrence(canvasElement, opener, detail);
  },
};
