import type { CanonicalAddress } from '@rezics/model/address';
import { resourceHref } from '../address/path.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { messages as pageMessages } from '../work-page/messages.ts';
import { ConnectionsSection, PublicCollectionPage, RelationRows, type Franchise } from './connections.tsx';
import * as fixture from './fixtures.ts';
import { copyOf } from './messages.ts';
import { namedWorkHref } from './names.tsx';
import { ConnectionsPreviewView } from './previews.tsx';
import { relationRows } from './relation-rows.ts';
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

const unrenderedEntry: RelationEntry = { ...fixture.relationEntries[1]!, relation: fixture.iri('f11'), rendering: null,
  counterparts: [fixture.summary(fixture.iri('f10'), 'A supplied counterpart without a readable role')] };
const nativeWithoutMeaning: RelationEntry = { ...purposeEntries[0]!,
  counterparts: [...unrenderedEntry.counterparts, ...unrenderedEntry.counterparts,
    { reference: fixture.iri('f13'), status: 'unavailable' }] };
const neutralRows = relationRows([nativeWithoutMeaning, { ...unrenderedEntry, counterparts: [] }, nativeWithoutMeaning]);

/** The shared legacy row consumer also retains a native incidence when Main supplied no meaning. */
export const NativeRowsWithoutMeaning: Story = {
  render: ({ locale = 'en' }) => <RelationRows rows={neutralRows} locale={locale} t={copyOf(locale)} />,
  async play({ canvasElement, args }) {
    const locale = args.locale ?? 'en', t = copyOf(locale), canvas = within(canvasElement);
    const links = canvas.getAllByRole('link', { name: 'A supplied counterpart without a readable role' });
    await expect(links).toHaveLength(4);
    const summary = unrenderedEntry.counterparts[0]!;
    if (summary.status !== 'available') throw new Error('Expected the public counterpart');
    for (const link of links) await expect(link).toHaveAttribute('href',
      localizedPath(resourceHref('/w/', summary.address as CanonicalAddress), locale));
    await expect(canvas.getAllByText(t.relatedFallback)).toHaveLength(3);
    await expect(canvas.getAllByText(t.nameNotShown)).toHaveLength(3);
    await expect(canvasElement.querySelector(`a[href*="${fixture.iri('f13').slice(-36)}"]`)).toBeNull();
    await expect(canvasElement.querySelector('[data-appearance-part]')).toBeNull();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const NativeRowsWithoutMeaningPhoneJapanese: Story = {
  ...NativeRowsWithoutMeaning,
  args: { locale: 'ja' },
  globals: { locale: 'ja', viewport: { value: 'phone' } },
};
const partiallyRendered: Loaded<RelationsPage> = purposeRelations.ok
  ? { ok: true, data: { ...purposeRelations.data, items: [...purposeEntries, unrenderedEntry, unrenderedEntry,
    { ...unrenderedEntry, relation: fixture.iri('f12'), counterparts: [{ reference: fixture.iri('f13'), status: 'unavailable' }] }],
    next: 'opaque:+/%?=&雪' } }
  : purposeRelations;

/** Missing semantic rendering does not erase a public incidence or pretend the page is complete. */
export const UnrenderedIncidences: Story = {
  args: { relations: partiallyRendered },
  async play({ canvasElement }) {
    await assertPurposeLinks(canvasElement, 'en');
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: copyOf('en').relatedFallback })).toBeVisible();
    const links = canvas.getAllByRole('link', { name: 'A supplied counterpart without a readable role' });
    await expect(links).toHaveLength(2);
    const summary = unrenderedEntry.counterparts[0]!;
    if (summary.status !== 'available') throw new Error('Expected the public counterpart');
    for (const link of links) await expect(link).toHaveAttribute('href', localizedPath(resourceHref('/w/', summary.address as CanonicalAddress), 'en'));
    await expect([...canvasElement.querySelectorAll('[data-relation]')].map(item => item.getAttribute('data-relation')))
      .toEqual([unrenderedEntry.relation, unrenderedEntry.relation, fixture.iri('f12')]);
    await expect(canvas.getByText(copyOf('en').nameNotShown)).toBeVisible();
    await expect(within(canvas.getByRole('navigation', { name: 'Relations pages' })).getByRole('link', { name: 'Show more' }))
      .toHaveAttribute('href', localizedPath(`${resourceHref('/w/', fixture.workRef)}/connections?relationsAfter=opaque%3A%2B%2F%25%3F%3D%26%E9%9B%AA#relations`, 'en'));
  },
};

export const UnrenderedIncidencesPreview: Story = {
  args: { relations: partiallyRendered, preview: true },
  async play({ canvasElement }) {
    await assertPurposeLinks(canvasElement, 'en');
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('link', { name: 'A supplied counterpart without a readable role' })).toHaveLength(2);
    await expect(canvas.getByText(copyOf('en').nameNotShown)).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'All connections' })).toHaveAttribute('href',
      localizedPath(`${resourceHref('/w/', fixture.workRef)}/connections#relations`, 'en'));
  },
};

// Supplied native-contract examples; these snapshots establish no backend persistence or authority.
const extraCounterpart = fixture.summary(fixture.iri('f51'), 'Companion anthology');
const withheldCounterpart = { reference: fixture.iri('f52'), status: 'unavailable' as const };
const semanticIncidence = fixture.relationEntries[1]!;
const partialIncidence = { ...semanticIncidence,
  counterparts: [...semanticIncidence.counterparts, extraCounterpart, withheldCounterpart, extraCounterpart] };
const semanticWithheld: RelationEntry = { ...semanticIncidence, relation: fixture.iri('f53'),
  rendering: null,
  counterparts: [fixture.summary(fixture.iri('f54'), 'Side story guide')] };
const suppliedPartialPage: RelationsPage = { profile: 'resource-relations-v1', resource: fixture.workRef,
  items: [purposeEntries[0]!, partialIncidence, partialIncidence, semanticWithheld], next: 'partial-next:+/%?=&雪',
  sourcePosition: { datasetId: 'product', dataEpoch: 'epoch', sequence: '1' } };
const retainedQuery: ConnectionsQuery = { grain: 'series', relationsAfter: 'relations-current:+/%?=&雪',
  membersAfter: 'members-current:+/%?=&雪', partsAfter: 'parts-current:+/%?=&雪' };

function RetainedConnections({ locale = 'en', preview = false, empty = false }: {
  locale?: UiLocale; preview?: boolean; empty?: boolean;
}) {
  const relations: Loaded<RelationsPage> = { ok: true, data: empty ? { ...suppliedPartialPage, items: [] } : suppliedPartialPage };
  const shared = { relations, workRef: fixture.workRef, locale, t: copyOf(locale), pageMessages: pageMessages[locale] };
  return <div className="mx-auto grid max-w-[46rem] gap-8 px-4 py-8 sm:px-8">
    {preview ? <ConnectionsPreviewView {...shared} /> : <ConnectionsSection {...shared} franchises={[]}
      names={fixture.names} current={fixture.current} query={retainedQuery} />}
  </div>;
}

async function assertRetainedNavigation(canvasElement: HTMLElement, locale: UiLocale, preview: boolean) {
  const canvas = within(canvasElement), t = copyOf(locale);
  const next = preview ? canvas.getByRole('link', { name: t.allConnections })
    : within(canvas.getByRole('navigation', { name: t.relationsPages })).getByRole('link', { name: t.showMore });
  await expect(next).toHaveAttribute('href', localizedPath(preview
    ? `${resourceHref('/w/', fixture.workRef)}/connections#relations`
    : `${resourceHref('/w/', fixture.workRef)}/connections?relationsAfter=partial-next%3A%2B%2F%25%3F%3D%26%E9%9B%AA&membersAfter=members-current%3A%2B%2F%25%3F%3D%26%E9%9B%AA&partsAfter=parts-current%3A%2B%2F%25%3F%3D%26%E9%9B%AA#relations`, locale));
  if (!preview) await expect(within(canvas.getByRole('navigation', { name: t.relationsPages }))
    .getByRole('link', { name: t.firstPage })).toHaveAttribute('href', localizedPath(
      `${resourceHref('/w/', fixture.workRef)}/connections?membersAfter=members-current%3A%2B%2F%25%3F%3D%26%E9%9B%AA&partsAfter=parts-current%3A%2B%2F%25%3F%3D%26%E9%9B%AA#relations`, locale));
  next.focus();
  await expect(next).toHaveFocus();
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}

export const PartialSemanticIncidences: Story = {
  parameters: { docs: { description: { story: 'Supplied native-contract example: the readable projection and every additional counterpart survive, including withheld names and repeated occurrences. This is component evidence, not a backend or authority test.' } } },
  render: (_args, { globals }) => <RetainedConnections locale={globals.locale as UiLocale} />,
  async play({ canvasElement, globals, args }) {
    const locale = globals.locale as UiLocale, canvas = within(canvasElement), t = copyOf(locale);
    await expect(canvas.getByRole('region', { name: t.connections })).toBeVisible();
    await expect(canvas.getByRole('region', { name: t.collections })).toBeVisible();
    await expect(canvas.getByText('Reboots of')).toBeVisible();
    const semanticTarget = semanticIncidence.counterparts[0]!;
    if (semanticTarget.status !== 'available' || extraCounterpart.status !== 'available') throw new Error('Expected supplied counterpart addresses');
    await expect(canvas.getAllByRole('link', { name: semanticTarget.name.value })).toHaveLength(2);
    for (const link of canvas.getAllByRole('link', { name: semanticTarget.name.value })) await expect(link).toHaveAttribute('href',
      localizedPath(resourceHref('/w/', semanticTarget.address as CanonicalAddress), locale));
    const rows = canvasElement.querySelectorAll<HTMLElement>('[data-relation]');
    await expect([...rows].map(row => row.getAttribute('data-relation')))
      .toEqual([partialIncidence.relation, partialIncidence.relation, semanticWithheld.relation]);
    for (const row of [...rows].slice(0, 2)) {
      await expect([...row.children].map(child => child.textContent)).toEqual(['Companion anthology', t.nameNotShown, 'Companion anthology']);
      const counterparts = within(row);
      await expect(counterparts.getAllByRole('link', { name: 'Companion anthology' })).toHaveLength(2);
      for (const link of counterparts.getAllByRole('link')) await expect(link).toHaveAttribute('href',
        localizedPath(resourceHref('/w/', extraCounterpart.address as CanonicalAddress), locale));
      await expect(counterparts.getByText(t.nameNotShown)).not.toHaveAttribute('href');
    }
    const withheldMeaning = semanticWithheld.counterparts[0]!;
    if (withheldMeaning.status !== 'available') throw new Error('Expected the supplied fallback address');
    await expect(within(rows[2]!).getByRole('link', { name: 'Side story guide' })).toHaveAttribute('href',
      localizedPath(resourceHref('/w/', withheldMeaning.address as CanonicalAddress), locale));
    await expect(canvasElement.querySelector(`a[href*="${withheldCounterpart.reference.slice(-36)}"]`)).toBeNull();
    await assertRetainedNavigation(canvasElement, locale, Boolean(args.preview));
  },
};

export const PartialSemanticIncidencesPreviewPhoneJapanese: Story = {
  ...PartialSemanticIncidences,
  args: { preview: true, locale: 'ja' },
  render: () => <RetainedConnections locale="ja" preview />,
  globals: { locale: 'ja', viewport: { value: 'phone' } },
};

export const EmptyContinuedRelations: Story = {
  parameters: { docs: { description: { story: 'Supplied native-contract empty continued page: an empty batch retains its opaque continuation and does not claim there are no connections.' } } },
  render: () => <RetainedConnections empty />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement), t = copyOf('en');
    await expect(canvas.getByRole('region', { name: t.connections })).toBeVisible();
    await expect(canvas.queryByText(t.noConnections)).toBeNull();
    await expect(canvas.queryAllByRole('listitem')).toHaveLength(0);
    await assertRetainedNavigation(canvasElement, 'en', false);
  },
};

export const EmptyContinuedRelationsPreviewPhoneJapanese: Story = {
  ...EmptyContinuedRelations,
  render: () => <RetainedConnections locale="ja" preview empty />,
  globals: { locale: 'ja', viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement), t = copyOf('ja');
    await expect(canvas.getByRole('region', { name: t.connections })).toBeVisible();
    await expect(canvas.queryByText(t.noConnections)).toBeNull();
    await expect(canvas.queryAllByRole('listitem')).toHaveLength(0);
    await assertRetainedNavigation(canvasElement, 'ja', true);
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
