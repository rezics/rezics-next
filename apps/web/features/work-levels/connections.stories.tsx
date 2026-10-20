import type { CanonicalAddress } from '@rezics/model/address';
import { resourceHref } from '../address/path.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { messages as pageMessages } from '../work-page/messages.ts';
import { ConnectionsSection, PublicCollectionPage, type Franchise } from './connections.tsx';
import * as fixture from './fixtures.ts';
import { copyOf } from './messages.ts';
import { namedWorkHref } from './names.tsx';
import { ConnectionsPreviewView } from './previews.tsx';
import type { ConnectionsQuery } from './route.ts';
import type { AvailableSummary, Loaded, RelationEntry, RelationsPage } from './types.ts';

// This fixture is an explicitly declared franchise; its title never supplies its purpose.
const franchiseRelations: Loaded<RelationsPage> = fixture.relations.ok ? { ok: true, data: { ...fixture.relations.data,
  items: fixture.relationEntries.map((entry, index) => index === 0 ? { ...entry, collectionPurpose: {
    kind: 'franchise', statement: fixture.iri('d01'), revision: fixture.iri('d02'), sources: [],
  } } : entry),
} } : fixture.relations;

const franchise = (grain: 'series' | 'parts', paged = false): Franchise => ({
  collection: fixture.summary(
    fixture.iri('900'),
    'A Certain Magical Index franchise',
    'en',
    'collection',
  ),
  members: {
    ok: true,
    data: {
      collection: fixture.iri('900'),
      next: null,
      members: [fixture.iri('100'), fixture.iri('200'), fixture.iri('300')].map(
        (target, index) => ({
          occurrence: fixture.iri(`8${index}`),
          role: 'member',
          parent: fixture.iri('9'),
          target,
          orderKey: `o${index}`,
          labels: [],
        }),
      ),
    },
  },
  parts:
    grain === 'parts' && fixture.parts.ok
      ? new Map([[fixture.iri('100'), paged ? fixture.pagedParts : fixture.parts]])
      : new Map(),
});

function Page({
  locale,
  grain = 'series',
  relations = franchiseRelations,
  preview = false,
  paged = false,
}: {
  locale: UiLocale;
  paged?: boolean;
  grain?: ConnectionsQuery['grain'];
  relations?: Loaded<RelationsPage>;
  preview?: boolean;
}) {
  const t = copyOf(locale);
  return (
    <div className="mx-auto grid max-w-[46rem] gap-8 px-4 py-8 sm:px-8">
      {preview ? (
        <ConnectionsPreviewView
          relations={relations}
          workRef={fixture.workRef}
          locale={locale}
          pageMessages={pageMessages[locale]}
          t={t}
        />
      ) : (
        <ConnectionsSection
          relations={relations}
          franchises={[franchise(grain, paged)]}
          names={fixture.names}
          workRef={fixture.workRef}
          current={fixture.current}
          query={{ grain }}
          locale={locale}
          t={t}
          pageMessages={pageMessages[locale]}
        />
      )}
    </div>
  );
}

const meta = {
  title: 'Work levels/Connections',
  component: Page,
  args: { locale: 'en' },
} satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Progressive shows Reboot and AGGO shows SpinOff: each row's heading is the label Main selected, its counterparts follow. */
export const TypedRelations: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const rows = canvasElement.querySelectorAll('[data-relation-row]');
    await expect(rows).toHaveLength(3);
    await expect(within(rows[0] as HTMLElement).getByText('Reboot of')).toBeVisible();
    await expect(within(rows[1] as HTMLElement).getByText('Spin-offs')).toBeVisible();
    await expect(within(rows[1] as HTMLElement).getAllByRole('link')).toHaveLength(2);
    // The derivation whose source version is not pinned is visibly unresolved, not hidden.
    await expect(canvas.getByText('Source version unresolved')).toBeVisible();
    await expect(canvasElement.querySelectorAll('[data-role-chip]')).toHaveLength(0);
    for (const entry of fixture.relationEntries) {
      for (const target of entry.counterparts) {
        if (target.status !== 'available' || target.type !== 'work') continue;
        for (const link of canvas.getAllByRole('link', { name: target.name.value })) {
          await expect(link).toHaveAttribute(
            'href',
            localizedPath(resourceHref('/w/', target.address as CanonicalAddress), 'en'),
          );
        }
      }
    }
  },
};

/** A label in another language than the reader asked for keeps its own language and direction and is marked. */
export const LabelFallback: Story = {
  async play({ canvasElement }) {
    const chips = canvasElement.querySelectorAll('[lang="ja"]');
    await expect(chips.length).toBeGreaterThan(0);
    await expect(within(canvasElement).getByText(/続編元/)).toBeVisible();
    await expect(within(canvasElement).getByText('in Japanese')).toBeVisible();
  },
};

/** The franchise lists its series; switching the grain lists their parts underneath. */
export const SeriesGrain: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('heading', { name: 'A Certain Magical Index franchise' }),
    ).toBeVisible();
    await expect(canvas.getByText('This Work')).toBeVisible();
    const switcher = canvas.getByRole('group', { name: 'Franchise level' });
    await expect(within(switcher).getByRole('link', { name: 'Series' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(within(switcher).getByRole('link', { name: 'Volumes and parts' })).toHaveAttribute(
      'href',
      localizedPath(
        `${resourceHref('/w/', fixture.workRef)}/connections?grain=parts#franchises`,
        'en',
      ),
    );
    await expect(canvas.queryByText('A Certain Magical Index NT 22 Reverse')).toBeNull();
  },
};

export const PartsGrain: Story = {
  args: { grain: 'parts' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(
      within(canvas.getByRole('group', { name: 'Franchise level' })).getByRole('link', {
        name: 'Volumes and parts',
      }),
    ).toHaveAttribute('aria-current', 'true');
    await expect(canvas.getByText('A Certain Magical Index NT 22 Reverse')).toBeVisible();
  },
};

/** A member with more parts than one page links to its own page for them. */
export const MemberWithMoreParts: Story = {
  args: { grain: 'parts', paged: true },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('link', { name: 'More parts…' })).toHaveAttribute(
      'href',
      localizedPath(`${namedWorkHref(fixture.iri('100'), fixture.names)}/connections#parts`, 'en'),
    );
  },
};

export const Japanese: Story = {
  args: { locale: 'ja' },
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('region', { name: 'つながり' })).toBeVisible();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const Preview: Story = {
  args: { preview: true },
  async play({ canvasElement }) {
    await expect(
      within(canvasElement).getByRole('link', { name: 'All connections' }),
    ).toHaveAttribute(
      'href',
      localizedPath(`${resourceHref('/w/', fixture.workRef)}/connections#relations`, 'en'),
    );
  },
};

export const SignInNeeded: Story = {
  args: { relations: { ok: false, failure: 'sign-in' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent(
      'Connections could not be loaded.',
    );
  },
};

const purposeCases = [
  [null, 'collections', 'A series and franchise in name only'],
  ['reading-list', 'readingLists', 'Franchise reading recommendations'],
  ['recipe-selection', 'recipeSelections', 'The dinner series'],
  ['series', 'series', 'An ordinary-sounding list'],
  ['franchise', 'franchises', 'The shared collection'],
] as const;
const purposeEntries: RelationEntry[] = purposeCases.map(([kind, , title], index) => {
  const reference = fixture.iri(`b0${index}`);
  return { relation: reference, kind: 'collection', revision: null, evidence: null,
    collectionPurpose: kind === null ? null : { kind, statement: fixture.iri(`b1${index}`), revision: fixture.iri(`b2${index}`), sources: [] },
    counterparts: [fixture.summary(reference, title, 'en', 'collection')],
    rendering: { profile: 'relation-rendering-v1', meaning: null,
      structuralBasis: { profile: 'collection-membership', collection: reference, member: fixture.iri('100') },
      occurrence: null, viewingRole: 'member', bindings: [], projections: [] } };
});
const purposeRelations: Loaded<RelationsPage> = fixture.relations.ok
  ? { ok: true, data: { ...fixture.relations.data, items: purposeEntries, next: 'relations-next+/=' } }
  : fixture.relations;
const purposeMembers: Franchise[] = purposeEntries.map((entry, index) => ({ collection: entry.counterparts[0]!, parts: new Map(),
  members: { ok: true, data: { collection: entry.relation, next: `members-next-${index}`,
    members: ['101', '102', '101'].map((target, occurrence) => ({ occurrence: fixture.iri(`c${index}${occurrence}`),
      role: 'member', parent: entry.relation, target: fixture.iri(target), orderKey: `${occurrence}`, labels: [] })) } },
}));
const purposeQuery: ConnectionsQuery = { grain: 'series', relationsAfter: 'relations-current', membersAfter: 'members-current', partsAfter: 'parts-current' };

function PurposePage({ locale = 'en', preview = false, refused = false }: { locale?: UiLocale; preview?: boolean; refused?: boolean }) {
  const shared = { locale, workRef: fixture.workRef, t: copyOf(locale), pageMessages: pageMessages[locale], relations: purposeRelations };
  const members: Franchise[] = refused ? purposeMembers.map((item, index) => ({ ...item,
    members: index < 3 ? { ok: false, failure: (['missing', 'sign-in', 'unavailable'] as const)[index]! }
      : { ok: true, data: { collection: item.collection.reference, members: [], next: `empty-next-${index}` } },
  })) : purposeMembers;
  return <div className="mx-auto grid max-w-[46rem] gap-8 px-4 py-8 sm:px-8">
    {preview ? <ConnectionsPreviewView {...shared} /> : <ConnectionsSection {...shared} franchises={[...members].reverse()}
      names={fixture.names} current={fixture.current} query={purposeQuery} />}
  </div>;
}

async function assertPurposeLinks(canvasElement: HTMLElement, locale: UiLocale) {
  const canvas = within(canvasElement), t = copyOf(locale);
  for (const [index, [, key, title]] of purposeCases.entries()) {
    const region = within(canvas.getByRole('region', { name: t[key] }));
    const summary = purposeEntries[index]!.counterparts[0]!;
    if (summary.status !== 'available') throw new Error('Expected an available Collection fixture');
    await expect(region.getByRole('heading', { name: t[key] })).toBeVisible();
    await expect(region.getByRole('link', { name: title })).toHaveAttribute('href',
      localizedPath(resourceHref('/e/', summary.address as CanonicalAddress), locale));
  }
}

/** Explicit purpose, not a title or a type label, determines each region. Repeated members remain separate occurrences. */
export const ExplicitCollectionPurposes: Story = {
  render: () => <PurposePage />,
  async play({ canvasElement }) {
    await assertPurposeLinks(canvasElement, 'en');
    const canvas = within(canvasElement), t = copyOf('en');
    for (const [index, [, key]] of purposeCases.entries()) {
      const region = within(canvas.getByRole('region', { name: t[key] }));
      await expect(region.getAllByRole('listitem').map(item => item.getAttribute('data-occurrence'))).toEqual(
        ['0', '1', '2'].map(occurrence => fixture.iri(`c${index}${occurrence}`)));
      await expect(region.getAllByRole('link', { name: 'A Certain Magical Index NT 1' })).toHaveLength(2);
      await expect(region.getByRole('link', { name: 'Show more' })).toHaveAttribute('href', localizedPath(
        `${resourceHref('/w/', fixture.workRef)}/connections?relationsAfter=relations-current&membersAfter=members-next-${index}&partsAfter=parts-current&franchise=${fixture.iri(`b0${index}`).slice(-36)}#franchises`, 'en'));
    }
    const pages = within(canvas.getByRole('navigation', { name: 'Relations pages' }));
    await expect(pages.getByRole('link', { name: 'Back to the start' })).toBeVisible();
    await expect(pages.getByRole('link', { name: 'Show more' })).toHaveAttribute('href', localizedPath(
      `${resourceHref('/w/', fixture.workRef)}/connections?relationsAfter=relations-next%2B%2F%3D&membersAfter=members-current&partsAfter=parts-current#relations`, 'en'));
  },
};

export const ExplicitCollectionPurposesPhone: Story = {
  render: () => <PurposePage locale="ja" />,
  globals: { locale: 'ja', viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await assertPurposeLinks(canvasElement, 'ja');
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const CollectionPurposesPreview: Story = {
  render: () => <PurposePage preview />,
  async play({ canvasElement }) {
    await assertPurposeLinks(canvasElement, 'en');
    await expect(within(canvasElement).getByRole('link', { name: 'All connections' })).toHaveAttribute('href',
      localizedPath(`${resourceHref('/w/', fixture.workRef)}/connections#relations`, 'en'));
    await expect(canvasElement.querySelector('[data-occurrence]')).toBeNull();
  },
};

export const RefusedCollectionMembers: Story = {
  render: () => <PurposePage refused />,
  async play({ canvasElement }) {
    await assertPurposeLinks(canvasElement, 'en');
    const canvas = within(canvasElement);
    await expect(within(canvas.getByRole('region', { name: 'Collections' })).getByRole('status')).toHaveTextContent(pageMessages.en.regionMissing);
    await expect(within(canvas.getByRole('region', { name: 'Reading lists' })).getByRole('alert')).toHaveTextContent(pageMessages.en.regionDenied);
    await expect(within(canvas.getByRole('region', { name: 'Recipe selections' })).getByRole('alert')).toHaveTextContent(pageMessages.en.regionUnavailable);
    const empty = within(canvas.getByRole('region', { name: 'Series' }));
    await expect(empty.queryByText(copyOf('en').noMembers)).toBeNull();
    await expect(empty.getByRole('link', { name: 'Show more' })).toHaveAttribute('href', localizedPath(
      `${resourceHref('/w/', fixture.workRef)}/connections?relationsAfter=relations-current&membersAfter=empty-next-3&partsAfter=parts-current&franchise=${fixture.iri('b03').slice(-36)}#franchises`, 'en'));
  },
};

const publicList = fixture.summary(fixture.iri('900'), 'A public reading list', 'en', 'collection') as AvailableSummary;
const collectionTask = `${resourceHref('/e/', publicList.address as CanonicalAddress)}?language=sv&tag=a&tag=b`;
const publicMembers = {
  occurrences: [
    { occurrence: fixture.iri('81'), parent: fixture.iri('9'), role: 'member', target: fixture.iri('300'), orderKey: 'a', labels: [] },
    { occurrence: fixture.iri('82'), parent: fixture.iri('9'), role: 'group', orderKey: 'b',
      labels: [{ value: 'مكتبة الأدب', language: 'ar' }] },
  ], names: fixture.names, nextCursor: 'members-page-2',
};

/** Anonymous Collection entry has real member destinations, groups and Main's continuation. */
export const PublicList: Story = {
  render: ({ locale }) => <PublicCollectionPage summary={publicList} page={{ ok: true, data: publicMembers }}
    currentUrl={collectionTask} locale={locale} messages={pageMessages[locale]} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: publicList.name.value })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Show more' })).toHaveAttribute('href',
      localizedPath(`${collectionTask}&after=members-page-2`, 'en'));
    await expect(canvas.getByRole('link', { name: 'مكتبة الأدب' })).toHaveAttribute('href',
      localizedPath(`${collectionTask}&parent=${encodeURIComponent(fixture.iri('82'))}`, 'en'));
  },
};

export const PublicListPhone: Story = {
  ...PublicList,
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { name: publicList.name.value })).toBeVisible();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const PublicListUnavailable: Story = {
  render: ({ locale }) => <PublicCollectionPage summary={publicList} page={{ ok: false, failure: 'unavailable' }}
    currentUrl={`${collectionTask}&after=members-page-2`} locale={locale} messages={pageMessages[locale]} />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('alert')).toBeVisible();
    await expect(within(canvasElement).getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(within(canvasElement).getByRole('link', { name: 'Lists' })).toBeVisible();
  },
};
