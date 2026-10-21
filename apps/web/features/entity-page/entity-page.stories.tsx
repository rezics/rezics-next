import type { CanonicalAddress } from '@rezics/model/address';
import { direction } from '@rezics/main/language';
import { localizedPath } from '../../i18n/locale.ts';
import { addressPath, resourceHref } from '../address/path.ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { servedTypes } from '../catalogue/type-fixtures.ts';
import { RelationRows } from '../work-levels/connections.tsx';
import { iri, relations as relationsPage, summary } from '../work-levels/fixtures.ts';
import type { Loaded, RelationEntry, RelationsPage } from '../work-levels/types.ts';
import { copyOf as levelsCopy } from '../work-levels/messages.ts';
import { relationRows } from '../work-levels/relation-rows.ts';
import * as fixture from '../work-page/fixtures.ts';
import { messages as workMessages } from '../work-page/messages.ts';
import { TargetRatingsRegion } from '../work-page/ratings.tsx';
import { EntityHeader } from './header.tsx';
import { drawnSections } from './views.tsx';
import { copyOf } from './messages.ts';
import { DiscussionView, RelationsView, StatementsView } from './views.tsx';
import { attributed } from '../rights-mark/fixtures.ts';
import { appearances, baseSections, componentStatements, noStatements, predicateLabels, projectionFor, statements, withheldCreditAppearance } from './fixtures.ts';
import { alter, identityEntry, saber } from './identity-fixtures.ts';
import type { IdentityData } from './identity-relations.ts';
import { IdentitySectionsView } from './identity-views.tsx';
import { standaloneHrefFor } from './route.ts';
import type { TargetBase } from './types.ts';

// One page per resource, any base: the stories draw the header and each section from typed Main responses, and the
// matrix fails when a type the registry knows, or does not, is given a book's controls.

const hrefFor = standaloneHrefFor({}, resourceHref('/e/', '0b9e4d2a-6c1f-4e8b-a3d5-7f2c9e1b4a6d'));
const character = projectionFor({ base: 'resource', types: ['https://rezics.com/vocab/Character'], name: 'Kirito' });
const common = (locale: UiLocale) => ({ locale, t: copyOf(locale), messages: workMessages[locale], hrefFor });

function Page({ locale = 'en', children }: { locale?: UiLocale; children: React.ReactNode }) {
  return <div className="mx-auto grid max-w-4xl gap-10 px-4 py-6">
    <EntityHeader summary={character.summary as never} registry={character.registry} locale={locale} t={copyOf(locale)} />
    {children}
  </div>;
}

const meta = { title: 'Entity page/Sections', component: Page, args: { children: null } } satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

const statementNames = new Map([[`https://rezics.com/id/c1e3a5f7-9b2d-4f6e-8c0a-2d4f6b8e0a1c`,
  summary('https://rezics.com/id/c1e3a5f7-9b2d-4f6e-8c0a-2d4f6b8e0a1c', 'Aincrad guild', 'en', 'resource')]]);

export const Statements: Story = {
  render: (_args, context) => {
    const locale = context.globals.locale as UiLocale;
    return <Page locale={locale}><StatementsView page={{ ok: true, data: statements('next') }} labels={predicateLabels} ownName="Kirito" names={statementNames}
      cursor={undefined} {...common(locale)} /></Page>;
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent('Kirito');
    await expect(canvas.getByText('Character')).toBeVisible();
    // A right-to-left value keeps its own direction inside the left-to-right page.
    await expect(canvas.getByText('الشبح الأسود')).toHaveAttribute('dir', 'auto');
    const guild = statementNames.get('https://rezics.com/id/c1e3a5f7-9b2d-4f6e-8c0a-2d4f6b8e0a1c')!;
    if (guild.status !== 'available') throw new Error('The guild fixture must have a canonical address');
    await expect(canvas.getByRole('link', { name: 'Aincrad guild' })).toHaveAttribute('href',
      localizedPath(resourceHref('/e/', guild.address as CanonicalAddress), 'en'));
    await expect(canvas.getByText('Unknown value')).toBeVisible();
    // The name the heading already shows is not repeated, a predicate without a label is gathered under "Other facts", and
    // no group draws an empty heading.
    await expect(canvas.getAllByText('Kirito')).toHaveLength(1);
    await expect(canvas.getByText('キリト')).toBeVisible();
    await expect(canvas.getByRole('heading', { level: 3, name: 'Other facts' })).toBeVisible();
    for (const heading of canvas.getAllByRole('heading', { level: 3 })) await expect(heading).not.toBeEmptyDOMElement();
    // The list continues by Main's cursor, on the same address.
    await expect(canvas.getByRole('link', { name: 'Next page' })).toHaveAttribute('href',
      localizedPath(`${resourceHref('/e/', '0b9e4d2a-6c1f-4e8b-a3d5-7f2c9e1b4a6d')}?statements=next#statements`, 'en'));
  },
};

export const LicensedFacts: Story = {
  render: () => <Page><StatementsView page={{ ok: true, data: { ...statements(), factObligations: attributed } }}
    labels={predicateLabels} ownName="Kirito" names={statementNames} cursor={undefined} {...common('en')} /></Page>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('キリト')).toBeVisible();
    await expect(canvas.getByText('الشبح الأسود')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Example' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'CC BY-SA 3.0' })).toBeVisible();
    await expect(canvas.getByText(/Adaptations stay under the same terms/)).toBeVisible();
    // The page's facts share one rights read, so the list carries one mark.
    await expect(canvasElement.querySelectorAll('[data-rights-mark]')).toHaveLength(1);
  },
};

export const LicensedFactsPhone: Story = {
  ...LicensedFacts,
  globals: { viewport: { value: 'phone' } },
  play: async (context) => {
    await LicensedFacts.play!(context);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const DefinitionLabels: Story = {
  render: () => <Page><StatementsView page={{ ok: true, data: statements() }} names={statementNames} cursor={undefined}
    labels={new Map([['https://schema.org/alternateName', { value: '別名', language: 'ja', direction: direction('ja', '別名') }]])}
    {...common('ja')} /></Page>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('別名')).toHaveAttribute('lang', 'ja');
    await expect(canvas.queryByText('alternateName')).toBeNull();
    await expect(canvas.queryByText('memberOf')).toBeNull();
    await expect(canvas.getByText('Aincrad guild')).toBeVisible();
  },
};

export const ComponentProperties: Story = {
  render: () => <Page><StatementsView page={{ ok: true, data: componentStatements }} names={new Map()} cursor={undefined}
    {...common('en')} /></Page>,
  async play({ canvasElement }) {
    const name = within(canvasElement).getByText('معرض الهولوغرام');
    // The owner's text keeps its own language and direction rather than appearing as a serialized record.
    await expect(name).toHaveAttribute('dir', 'rtl');
    await expect(name).toHaveAttribute('lang', 'ar');
  },
};

export const StatementsEmpty: Story = {
  render: () => <Page><StatementsView page={{ ok: true, data: noStatements }} names={new Map()} cursor={undefined}
    {...common('en')} /></Page>,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('No statements yet')).toBeVisible();
  },
};

export const StatementsFailedOnAStaleCursor: Story = {
  render: () => <Page><StatementsView page={{ ok: false, failure: 'moved' }} names={new Map()} cursor="stale"
    {...common('en')} /></Page>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('Statements could not be loaded.');
    // A stale cursor restarts from the first page rather than retrying the same one.
    await expect(canvas.getByRole('link', { name: 'First page' })).toHaveAttribute('href',
      localizedPath(`${resourceHref('/e/', '0b9e4d2a-6c1f-4e8b-a3d5-7f2c9e1b4a6d')}#statements`, 'en'));
  },
};

export const Relations: Story = {
  render: (_args, context) => {
    const locale = context.globals.locale as UiLocale;
    return <Page locale={locale}><RelationsView page={relationsPage} cursor={undefined} {...common(locale)} /></Page>;
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Relations' })).toBeVisible();
    // A counterpart that is a Work links to its own host.
    await expect(canvas.getAllByRole('link').some(link => addressPath(link.getAttribute('href') ?? '')?.lookup.scope === 'work')).toBe(true);
  },
};

const purposeCases = [
  [null, 'collections', 'A franchise in name only'], ['reading-list', 'readingLists', 'The recommended series'],
  ['recipe-selection', 'recipeSelections', 'Franchise dinners'], ['series', 'series', 'A plain collection'],
  ['franchise', 'franchises', 'The shared reading list'],
] as const;
const purposeEntries: RelationEntry[] = purposeCases.map(([kind, , title], index) => {
  const reference = iri(`b0${index}`);
  return { relation: reference, kind: 'collection', revision: null, evidence: null,
    collectionPurpose: kind === null ? null : { kind, statement: iri(`b1${index}`), revision: iri(`b2${index}`), sources: [] },
    counterparts: [summary(reference, title, 'en', 'resource')],
    rendering: { profile: 'relation-rendering-v1', meaning: null,
      structuralBasis: { profile: 'collection-membership', collection: reference, member: character.summary.reference },
      occurrence: null, viewingRole: 'member', bindings: [], projections: [] } };
});

export const CollectionPurposes: Story = {
  render: (_args, context) => {
    const locale = context.globals.locale as UiLocale;
    return <Page locale={locale}><RelationsView page={{ ok: true, data: { profile: 'resource-relations-v1',
      resource: character.summary.reference, items: purposeEntries, next: 'next+/=',
      sourcePosition: { datasetId: 'product', dataEpoch: 'epoch', sequence: '1' } } }} cursor="current"
      {...common(locale)} /></Page>;
  },
  async play({ canvasElement, globals }) {
    const locale = globals.locale as UiLocale, canvas = within(canvasElement), t = levelsCopy(locale);
    for (const [index, [, key, title]] of purposeCases.entries()) {
      const group = within(canvas.getByRole('region', { name: t[key] }));
      const named = purposeEntries[index]!.counterparts[0]!;
      if (named.status !== 'available') throw new Error('Expected a named Collection');
      await expect(group.getByRole('heading', { name: t[key] })).toBeVisible();
      await expect(group.getByRole('link', { name: title })).toHaveAttribute('href',
        localizedPath(resourceHref('/e/', named.address as CanonicalAddress), locale));
    }
    const pages = within(canvas.getByRole('navigation', { name: workMessages[locale].pagination }));
    await expect(pages.getByRole('link', { name: workMessages[locale].nextPage })).toHaveAttribute('href',
      localizedPath(`${resourceHref('/e/', '0b9e4d2a-6c1f-4e8b-a3d5-7f2c9e1b4a6d')}?relations=next%2B%2F%3D#relations`, locale));
  },
};

export const CollectionPurposesPhone: Story = {
  ...CollectionPurposes,
  globals: { locale: 'ja', viewport: { value: 'phone' } },
  async play(context) {
    await CollectionPurposes.play?.(context);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

// Supplied native-contract examples, not a backend selection or authority fixture.
const extraCounterpart = summary(iri('f51'), 'Companion anthology');
const withheldCounterpart = { reference: iri('f52'), status: 'unavailable' as const };
const partialIncidence: RelationEntry = { ...identityEntry('work', 'character', alter),
  counterparts: [alter, extraCounterpart, withheldCounterpart, extraCounterpart] };
const semanticWithheld: RelationEntry = { ...partialIncidence, relation: iri('f53'),
  rendering: null,
  counterparts: [summary(iri('f54'), 'Side story guide')] };
const partialPage: Loaded<RelationsPage> = { ok: true, data: {
  profile: 'resource-relations-v1', resource: character.summary.reference,
  items: [purposeEntries[0]!, partialIncidence, partialIncidence, semanticWithheld], next: 'partial-next:+/%?=&雪',
  sourcePosition: { datasetId: 'product', dataEpoch: 'epoch', sequence: '1' },
} };

export const PartialSemanticIncidences: Story = {
  parameters: { docs: { description: { story: 'Supplied native-contract example: two retained incidences each have a readable projection and additional, withheld and repeated counterparts. No native selection or persistence is exercised.' } } },
  render: (_args, { globals }) => <Page locale={globals.locale as UiLocale}>
    <RelationsView page={partialPage} cursor="partial-current:+/%?=&雪" {...common(globals.locale as UiLocale)} />
  </Page>,
  async play({ canvasElement, globals }) {
    const locale = globals.locale as UiLocale, canvas = within(canvasElement), levels = levelsCopy(locale);
    await expect(canvas.getByRole('region', { name: copyOf(locale).relations })).toBeVisible();
    await expect(canvas.getByRole('region', { name: levels.collections })).toBeVisible();
    await expect(canvasElement.querySelectorAll('[data-role-chip]')).toHaveLength(2);
    for (const chip of canvasElement.querySelectorAll<HTMLElement>('[data-role-chip]')) {
      await expect(within(chip).getByRole('link', { name: alter.name.value })).toHaveAttribute('href',
        localizedPath(resourceHref('/e/', alter.address as CanonicalAddress), locale));
    }
    const rows = canvasElement.querySelectorAll<HTMLElement>('[data-relation]');
    await expect([...rows].map(row => row.getAttribute('data-relation')))
      .toEqual([partialIncidence.relation, partialIncidence.relation, semanticWithheld.relation]);
    if (extraCounterpart.status !== 'available') throw new Error('Expected the supplied counterpart address');
    for (const row of [...rows].slice(0, 2)) {
      const counterparts = within(row);
      await expect([...row.children].map(child => child.textContent)).toEqual(['Companion anthology', levels.nameNotShown, 'Companion anthology']);
      await expect(counterparts.getAllByRole('link', { name: 'Companion anthology' })).toHaveLength(2);
      for (const link of counterparts.getAllByRole('link')) await expect(link).toHaveAttribute('href',
        localizedPath(resourceHref('/w/', extraCounterpart.address as CanonicalAddress), locale));
      await expect(counterparts.getByText(levels.nameNotShown)).not.toHaveAttribute('href');
    }
    const withheldMeaning = semanticWithheld.counterparts[0]!;
    if (withheldMeaning.status !== 'available') throw new Error('Expected the supplied fallback address');
    await expect(within(rows[2]!).getByRole('link', { name: 'Side story guide' })).toHaveAttribute('href',
      localizedPath(resourceHref('/w/', withheldMeaning.address as CanonicalAddress), locale));
    await expect(rows[2]!.querySelector('[data-role-chip]')).toBeNull();
    await expect(canvasElement.querySelector(`a[href*="${withheldCounterpart.reference.slice(-36)}"]`)).toBeNull();
    const pages = within(canvas.getByRole('navigation', { name: workMessages[locale].pagination }));
    await expect(pages.getByRole('link', { name: workMessages[locale].firstPage })).toHaveAttribute('href',
      localizedPath(`${resourceHref('/e/', '0b9e4d2a-6c1f-4e8b-a3d5-7f2c9e1b4a6d')}#relations`, locale));
    const next = pages.getByRole('link', { name: workMessages[locale].nextPage });
    await expect(next).toHaveAttribute('href', localizedPath(
      `${resourceHref('/e/', '0b9e4d2a-6c1f-4e8b-a3d5-7f2c9e1b4a6d')}?relations=partial-next%3A%2B%2F%25%3F%3D%26%E9%9B%AA#relations`, locale));
    next.focus();
    await expect(next).toHaveFocus();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const PartialSemanticIncidencesPhoneJapanese: Story = {
  ...PartialSemanticIncidences,
  globals: { locale: 'ja', viewport: { value: 'phone' } },
};

const ownCurrent = 'own-current:+/%?=&雪', ownNext = 'own-next:+/%?=&雪';
const familyCurrent = 'family-current:+/%?=&雪', familyNext = 'family-next:+/%?=&雪';
const familyBase = resourceHref('/e/', alter.address as CanonicalAddress);
const familyEntries = ['801', '802', '803'].map(id => ({ ...identityEntry('hub', 'variant', alter), relation: iri(id) }));
const suppliedLateFamily: Loaded<IdentityData> = { ok: true, data: { sections: [{
  kind: 'family', hub: saber, hidden: false, next: { resource: saber, cursor: familyNext },
  members: [
    { summary: saber, entry: null, hub: true, kind: null, applicability: [], ratings: null },
    ...familyEntries.map(entry => ({ summary: alter, entry, hub: false, kind: null, applicability: [], ratings: null })),
  ],
}] } };

/** The two snapshots are supplied reader output; this story does not select a family from mixed native pages. */
function LateHubPage({ locale }: { locale: UiLocale }) {
  const [continued, setContinued] = useState(false);
  const cursors = { family: familyCurrent, ...(continued ? { relations: ownCurrent } : {}) };
  const links = standaloneHrefFor(cursors, familyBase);
  const currentHref = `${familyBase}?${new URLSearchParams(cursors)}`;
  const page: Loaded<RelationsPage> = { ok: true, data: { profile: 'resource-relations-v1',
    resource: alter.reference, items: [], next: continued ? ownNext : ownCurrent,
    sourcePosition: { datasetId: 'product', dataEpoch: 'epoch', sequence: '1' } } };
  // Storybook's next/link stand-in is an anchor. Replace only this supplied
  // continuation snapshot, without a remote request or a client family selector.
  return <div className="mx-auto grid max-w-4xl gap-8 px-4 py-6" onClickCapture={event => {
    const link = event.target instanceof Element ? event.target.closest('a') : null;
    if (link?.getAttribute('href') === localizedPath(links({ kind: 'continue', section: 'relations', cursor: ownCurrent }), locale)) {
      event.preventDefault();
      setContinued(true);
    }
  }}>
      <h1 className="font-semibold text-2xl">{alter.name.value}</h1>
      <IdentitySectionsView data={continued ? suppliedLateFamily : { ok: true, data: { sections: [] } }} self={alter}
        locale={locale} t={copyOf(locale)} messages={workMessages[locale]} hrefFor={links} currentHref={currentHref} />
      <RelationsView page={page} cursor={continued ? ownCurrent : undefined} {...common(locale)} hrefFor={links} />
  </div>;
}

export const LateHubRepeatedOccurrences: Story = {
  parameters: { docs: { description: { story: 'Supplied native-contract reader snapshots: the initial own page has no family; a continued page supplies a late hub and three distinct occurrences naming one target. This tests production components, not completeness of mixed-page family discovery.' } } },
  render: (_args, { globals }) => <LateHubPage locale={globals.locale as UiLocale} />,
  async play({ canvasElement, globals }) {
    const locale = globals.locale as UiLocale, canvas = within(canvasElement), t = copyOf(locale), messages = workMessages[locale];
    await expect(canvas.queryByRole('region', { name: t.variantFamily })).toBeNull();
    await expect(canvas.queryByText(t.noRelations)).toBeNull();
    const next = canvas.getByRole('link', { name: messages.nextPage });
    await expect(next).toHaveAttribute('href', localizedPath(
      `${familyBase}?family=family-current%3A%2B%2F%25%3F%3D%26%E9%9B%AA&relations=own-current%3A%2B%2F%25%3F%3D%26%E9%9B%AA#relations`, locale));
    next.focus();
    await userEvent.keyboard('{Enter}');
    const family = await canvas.findByRole('region', { name: t.variantFamily });
    const members = family.querySelectorAll<HTMLElement>('[data-identity-member]');
    await expect([...members].map(member => member.getAttribute('data-identity-member')))
      .toEqual([saber.reference, alter.reference, alter.reference, alter.reference]);
    await expect(within(family).getByText(t.visibleRelationsOnly)).toBeVisible();
    for (const member of [...members].slice(1)) {
      await expect(within(member).getByRole('link', { name: alter.name.value })).toHaveAttribute('href',
        localizedPath(familyBase, locale));
      await expect(within(member).getByText(t.unknownVariantKind)).toBeVisible();
    }
    const hub = family.querySelector<HTMLElement>('[data-identity-hub]');
    await expect(hub).toHaveTextContent(t.variantOf);
    await expect(within(hub!).getByRole('link', { name: saber.name.value })).toHaveAttribute('href',
      localizedPath(resourceHref('/e/', saber.address as CanonicalAddress), locale));
    const more = within(family).getByRole('link', { name: t.moreIdentityRelations });
    await expect(more).toHaveAttribute('href', localizedPath(
      `${familyBase}?family=family-next%3A%2B%2F%25%3F%3D%26%E9%9B%AA&relations=own-current%3A%2B%2F%25%3F%3D%26%E9%9B%AA#identity-family`, locale));
    await expect(canvas.getByRole('link', { name: messages.nextPage })).toHaveAttribute('href', localizedPath(
      `${familyBase}?family=family-current%3A%2B%2F%25%3F%3D%26%E9%9B%AA&relations=own-next%3A%2B%2F%25%3F%3D%26%E9%9B%AA#relations`, locale));
    await expect(canvas.queryByText(t.noRelations)).toBeNull();
    more.focus();
    await expect(more).toHaveFocus();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const LateHubRepeatedOccurrencesPhoneJapanese: Story = {
  ...LateHubRepeatedOccurrences,
  globals: { locale: 'ja', viewport: { value: 'phone' } },
};

const variantsCurrent = 'variants-current:+/%?=&雪', variantsNext = 'variants-next:+/%?=&雪';
const variantsAfter = 'variants-after:+/%?=&雪', selectedHubNext = 'selected-hub-next:+/%?=&雪';
const selectedPosition: RelationsPage['sourcePosition'] = { datasetId: 'product', dataEpoch: 'epoch', sequence: '12' };
const selectedPage = (resource: string, items: RelationEntry[], next: string | null): RelationsPage => ({
  profile: 'resource-relations-v1', resource, items, next, sourcePosition: selectedPosition,
});
const selectedFamilyEntries = [
  { ...familyEntries[0]!, counterparts: [alter, extraCounterpart, withheldCounterpart, alter] },
  ...familyEntries.slice(1), semanticWithheld,
];
const selectedDiscoveryEntry: RelationEntry = { ...identityEntry('variant', 'hub', saber),
  counterparts: [saber, extraCounterpart, withheldCounterpart] };
const selectedTerminalEntry: RelationEntry = { ...semanticWithheld, counterparts: [withheldCounterpart] };
const selectedGenericPage = selectedPage(alter.reference, [semanticWithheld, partialIncidence, partialIncidence], ownNext);

/** Supplied native-selector reader snapshots, including independently continued variant and hub selections. */
function SelectedIdentityPage({ locale, terminal = false }: { locale: UiLocale; terminal?: boolean }) {
  const [discovered, setDiscovered] = useState(false);
  const cursors = { relations: ownCurrent, variants: discovered ? variantsNext : variantsCurrent,
    ...(!discovered ? { family: familyCurrent } : {}) };
  const links = standaloneHrefFor(cursors, familyBase);
  const currentHref = `${familyBase}?${new URLSearchParams(cursors)}`;
  const familyPage = selectedPage(discovered ? saber.reference : alter.reference,
    discovered ? selectedFamilyEntries : terminal ? [selectedTerminalEntry] : [],
    terminal ? null : discovered ? selectedHubNext : familyNext);
  const discoveryPage = selectedPage(alter.reference,
    discovered ? [selectedDiscoveryEntry] : [], terminal ? null : discovered ? variantsAfter : variantsNext);
  const data: Loaded<IdentityData> = { ok: true, data: { relations: selectedGenericPage, sections: [{
    kind: 'family', hub: discovered ? saber : null, hidden: false,
    members: discovered ? [
      { summary: saber, entry: null, hub: true, kind: null, applicability: [], ratings: null },
      ...selectedFamilyEntries.slice(0, 3).map(entry => ({ summary: alter, entry, hub: false, kind: null, applicability: [], ratings: null })),
    ] : [],
    next: familyPage.next ? { resource: discovered ? saber : alter, cursor: familyPage.next } : null,
    page: familyPage, cursor: cursors.family, cursorKey: 'family',
    fallback: discovered ? [
      { ...selectedFamilyEntries[0]!, counterparts: [extraCounterpart, withheldCounterpart, alter] }, semanticWithheld,
    ] : terminal ? [selectedTerminalEntry] : [],
    discovery: { page: discoveryPage, cursor: cursors.variants,
      fallback: discovered ? [{ ...selectedDiscoveryEntry, counterparts: [extraCounterpart, withheldCounterpart] }] : [] },
  }] } };
  const discoveryDestination = new URL(currentHref, 'https://rezics.invalid');
  discoveryDestination.searchParams.set('variants', variantsNext);
  discoveryDestination.searchParams.delete('family');
  discoveryDestination.hash = 'identity-family';
  return <div className="mx-auto grid max-w-4xl gap-8 px-4 py-6" onClickCapture={event => {
    const link = event.target instanceof Element ? event.target.closest('a') : null;
    if (!terminal && link?.getAttribute('href') === localizedPath(
      discoveryDestination.pathname + discoveryDestination.search + discoveryDestination.hash, locale)) {
      event.preventDefault();
      setDiscovered(true);
    }
  }}>
    <h1 className="font-semibold text-2xl">{alter.name.value}</h1>
    <IdentitySectionsView data={data} self={alter} locale={locale} t={copyOf(locale)} messages={workMessages[locale]}
      hrefFor={links} currentHref={currentHref} />
    <RelationsView page={{ ok: true, data: selectedGenericPage }} cursor={ownCurrent} {...common(locale)} hrefFor={links} />
  </div>;
}

export const SelectedIdentityFrontiers: Story = {
  parameters: { docs: { description: { story: 'Supplied native-contract reader snapshots: empty selected discovery and hub pages retain their independent opaque continuations. Following discovery supplies a late hub, three distinct occurrences of one target and every additional/withheld counterpart. Generic Relations keeps its original page. This component example establishes no backend selection, persistence or authority.' } } },
  render: (_args, { globals }) => <SelectedIdentityPage locale={globals.locale as UiLocale} />,
  async play({ canvasElement, globals }) {
    const locale = globals.locale as UiLocale, canvas = within(canvasElement), t = copyOf(locale), messages = workMessages[locale];
    const initialFamily = canvas.getByRole('region', { name: t.variantFamily });
    await expect(within(initialFamily).getByText(t.visibleRelationsOnly)).toBeVisible();
    await expect(canvas.queryByText(t.noVariants)).toBeNull();
    const initialMore = within(initialFamily).getAllByRole('link', { name: t.moreIdentityRelations });
    await expect(initialMore).toHaveLength(2);
    const hubUrl = new URL(initialMore[0]!.getAttribute('href')!, 'https://rezics.invalid');
    await expect(hubUrl.searchParams.get('family')).toBe(familyNext);
    await expect(hubUrl.searchParams.get('variants')).toBe(variantsCurrent);
    await expect(hubUrl.searchParams.get('relations')).toBe(ownCurrent);
    const discovery = within(initialFamily).getByRole('navigation', { name: t.variantOf });
    await expect(within(discovery).getByText(t.variantOf)).toBeVisible();
    const discoverMore = within(discovery).getByRole('link', { name: t.moreIdentityRelations });
    const discoveryUrl = new URL(discoverMore.getAttribute('href')!, 'https://rezics.invalid');
    await expect(discoveryUrl.searchParams.get('variants')).toBe(variantsNext);
    await expect(discoveryUrl.searchParams.has('family')).toBe(false);
    await expect(discoveryUrl.searchParams.get('relations')).toBe(ownCurrent);
    const genericBefore = canvas.getByRole('region', { name: t.relations }).textContent;
    discoverMore.focus();
    await expect(discoverMore).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    const family = canvas.getByRole('region', { name: t.variantFamily });
    const members = [...family.querySelectorAll<HTMLElement>('[data-identity-member]')];
    await expect(members.map(member => member.getAttribute('data-identity-member')))
      .toEqual([saber.reference, alter.reference, alter.reference, alter.reference]);
    for (const member of members.slice(1)) {
      await expect(within(member).getByRole('link', { name: alter.name.value })).toHaveAttribute('href', localizedPath(familyBase, locale));
      await expect(within(member).getByText(t.unknownVariantKind)).toBeVisible();
    }
    const companionLinks = within(family).getAllByRole('link', { name: 'Companion anthology' });
    await expect(companionLinks).toHaveLength(2);
    const guide = semanticWithheld.counterparts[0]!;
    if (extraCounterpart.status !== 'available' || guide.status !== 'available') throw new Error('Expected canonical fixture addresses');
    for (const link of companionLinks) await expect(link).toHaveAttribute('href',
      localizedPath(resourceHref('/w/', extraCounterpart.address as CanonicalAddress), locale));
    await expect(within(family).getByRole('link', { name: 'Side story guide' })).toHaveAttribute('href',
      localizedPath(resourceHref('/w/', guide.address as CanonicalAddress), locale));
    await expect(within(family).getAllByText(levelsCopy(locale).nameNotShown)).toHaveLength(2);
    await expect(within(family).queryByRole('link', { name: levelsCopy(locale).nameNotShown })).toBeNull();
    await expect(family.querySelectorAll('[data-relation]').length).toBe(3);
    await expect(canvas.getByRole('region', { name: t.relations }).textContent).toBe(genericBefore);
    const familyMore = within(family).getAllByRole('link', { name: t.moreIdentityRelations })[0]!;
    const familyUrl = new URL(familyMore.getAttribute('href')!, 'https://rezics.invalid');
    await expect(familyUrl.searchParams.get('family')).toBe(selectedHubNext);
    await expect(familyUrl.searchParams.get('variants')).toBe(variantsNext);
    const discoveryMore = within(within(family).getByRole('navigation', { name: t.variantOf }))
      .getByRole('link', { name: t.moreIdentityRelations });
    const discoveryAfter = new URL(discoveryMore.getAttribute('href')!, 'https://rezics.invalid');
    await expect(discoveryAfter.searchParams.get('variants')).toBe(variantsAfter);
    await expect(discoveryAfter.searchParams.has('family')).toBe(false);
    const genericMore = canvas.getByRole('link', { name: messages.nextPage });
    const genericUrl = new URL(genericMore.getAttribute('href')!, 'https://rezics.invalid');
    await expect(genericUrl.searchParams.get('relations')).toBe(ownNext);
    await expect(genericUrl.searchParams.get('variants')).toBe(variantsNext);
    await expect(genericUrl.searchParams.has('family')).toBe(false);
    familyMore.focus();
    await expect(familyMore).toHaveFocus();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const SelectedIdentityFrontiersPhoneJapanese: Story = {
  ...SelectedIdentityFrontiers,
  globals: { locale: 'ja', viewport: { value: 'phone' } },
};

export const SelectedIdentityTerminalPage: Story = {
  parameters: { docs: { description: { story: 'Supplied native-contract terminal reader pages without readable members retain First page for each current cursor; the selected family page retains its withheld incidence without an invented destination. Generic Relations has a separate next page.' } } },
  render: (_args, { globals }) => <SelectedIdentityPage locale={globals.locale as UiLocale} terminal />,
  async play({ canvasElement, globals }) {
    const locale = globals.locale as UiLocale, canvas = within(canvasElement), t = copyOf(locale), messages = workMessages[locale];
    const family = within(canvas.getByRole('region', { name: t.variantFamily }));
    const starts = family.getAllByRole('link', { name: messages.firstPage });
    await expect(starts).toHaveLength(2);
    const hub = new URL(starts[0]!.getAttribute('href')!, 'https://rezics.invalid');
    await expect(hub.searchParams.has('family')).toBe(false);
    await expect(hub.searchParams.get('variants')).toBe(variantsCurrent);
    const discovery = new URL(starts[1]!.getAttribute('href')!, 'https://rezics.invalid');
    await expect(discovery.searchParams.has('variants')).toBe(false);
    await expect(discovery.searchParams.has('family')).toBe(false);
    for (const url of [hub, discovery]) await expect(url.searchParams.get('relations')).toBe(ownCurrent);
    await expect(within(family.getByRole('navigation', { name: t.variantOf })).getByText(t.variantOf)).toBeVisible();
    await expect(family.queryByRole('link', { name: t.moreIdentityRelations })).toBeNull();
    await expect(family.getByText(t.visibleRelationsOnly)).toBeVisible();
    await expect(family.getByText(levelsCopy(locale).nameNotShown)).toBeVisible();
    await expect(family.queryByRole('link', { name: levelsCopy(locale).nameNotShown })).toBeNull();
    await expect(canvas.queryByText(t.noVariants)).toBeNull();
    const generic = new URL(canvas.getByRole('link', { name: messages.nextPage }).getAttribute('href')!, 'https://rezics.invalid');
    await expect(generic.searchParams.get('relations')).toBe(ownNext);
    await expect(generic.searchParams.get('family')).toBe(familyCurrent);
    await expect(generic.searchParams.get('variants')).toBe(variantsCurrent);
    starts[1]!.focus();
    await expect(starts[1]).toHaveFocus();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const SelectedIdentityTerminalPagePhoneJapanese: Story = {
  ...SelectedIdentityTerminalPage,
  globals: { locale: 'ja', viewport: { value: 'phone' } },
};

export const Appearances: Story = {
  render: (_args, context) => {
    const locale = context.globals.locale as UiLocale;
    return <Page locale={locale}><RelationsView page={{ ok: true, data: appearances() }} cursor={undefined} {...common(locale)} /></Page>;
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    // Each appearance reads as its Work with the role it had there, and the credited name where one is recorded.
    const rows = canvas.getAllByRole('listitem').filter(item => item.textContent?.includes('A Certain'));
    await expect(rows).toHaveLength(2);
    await expect(rows[0]).toHaveTextContent(/A Certain Magical Index\s*·\s*RoleSupporting character\s*as Mikoto/);
    await expect(rows[1]).toHaveTextContent(/A Certain Scientific Railgun\s*·\s*RoleLead character/);
    await expect(canvasElement.querySelector('[data-role-chip]')).toBeNull();
  },
};

/** A credited name Main withheld: the role stays, and the label links to where the name may be read. */
export const WithheldCredit: Story = {
  render: () => <Page><RelationsView page={{ ok: true, data: withheldCreditAppearance() }} cursor={undefined} {...common('en')} /></Page>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const row = canvas.getByRole('listitem');
    await expect(row).toHaveTextContent('Translator');
    await expect(row).toHaveTextContent('A Certain Magical Index');
    const credit = within(row).getByRole('link', { name: 'Name not shown' });
    await expect(credit).toBeVisible();
    await expect(credit.getAttribute('href') ?? '').not.toContain('https://rezics.com/id/');
    await expect(canvasElement.textContent ?? '').not.toContain('Hidden Alias');
  },
};

/** A work's character chip whose credited name is withheld still names the role. */
export const WithheldCharacterChip: Story = {
  render: () => {
    const appearance = identityEntry('work', 'character', alter);
    const argument = appearance.rendering!.projections[0]!.arguments[0]!;
    argument.creditedName = {
      lexical: 'Hidden Alias', language: 'en', reference: alter.reference, status: 'unavailable',
    } as typeof argument.creditedName;
    return <Page><RelationRows rows={relationRows([appearance])} locale="en" t={levelsCopy('en')} /></Page>;
  },
  async play({ canvasElement }) {
    const chip = canvasElement.querySelector('[data-role-chip]');
    await expect(chip).toHaveTextContent('character');
    await expect(chip).toHaveTextContent('Saber Alter');
    await expect(within(chip as HTMLElement).getByRole('link', { name: 'Name not shown' })).toBeVisible();
    await expect(canvasElement.textContent ?? '').not.toContain('Hidden Alias');
  },
};

export const RelationsFailed: Story = {
  render: () => <Page><RelationsView page={{ ok: false, failure: 'unavailable' }} cursor={undefined} {...common('en')} /></Page>,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent('Relations could not be loaded.');
  },
};

export const Discussion: Story = {
  render: (_args, context) => {
    const locale = context.globals.locale as UiLocale;
    return <Page locale={locale}><DiscussionView page={fixture.discussion} cursor={undefined}
      resource="https://rezics.com/id/0b9e4d2a-6c1f-4e8b-a3d5-7f2c9e1b4a6d" subject="character" signedIn
      realms={new Map()} {...common(locale)} /></Page>;
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    // The same action on every page: it names the resource's kind and leads to the composer with it as the target.
    const discuss = canvas.getAllByRole('link', { name: 'Discuss this character' })[0]!;
    await expect(discuss).toHaveAttribute('href', '/en/submit?target=0b9e4d2a-6c1f-4e8b-a3d5-7f2c9e1b4a6d');
    await expect(canvas.getAllByRole('article').length).toBeGreaterThan(0);
  },
};

export const DiscussionEmptyAnonymous: Story = {
  render: () => <Page><DiscussionView page={fixture.noDiscussion} cursor={undefined}
    resource="https://rezics.com/id/0b9e4d2a-6c1f-4e8b-a3d5-7f2c9e1b4a6d" subject="release" signedIn={false}
    realms={new Map()} {...common('en')} /></Page>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    // A signed-out reader is sent to sign in and back to the composer.
    await expect(canvas.getAllByRole('link', { name: 'Discuss this release' })[0]).toHaveAttribute('href',
      expect.stringContaining('/auth/start?next='));
  },
};

export const Ratings: Story = {
  render: () => <Page><TargetRatingsRegion ratings={fixture.globalRatings} subject={copyOf('en').ratingsFor({ subject: 'release' })}
    none={copyOf('en').noRatings} locale="en" messages={workMessages.en} /></Page>,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('Ratings for this release')).toBeVisible();
  },
};

/** Every registry entry on its base: the header says what it is and the page offers no book controls unless it is a book. */
const bases = Object.keys(baseSections) as TargetBase[];
const registryBase = (base: TargetBase) => base === 'work' || base === 'resource' || base === 'projection' ? base : 'record';
const entries = bases.flatMap(base => servedTypes.types.filter(entry => entry.base === registryBase(base))
  .map(entry => ({ base, entry })));

export const BaseByPresentationMatrix: Story = {
  render: () => <div className="grid gap-6 p-4">{entries.map(({ base, entry }) => {
    const page = projectionFor({ base, types: [entry.type], name: `${base} ${entry.presentation}` });
    return <section key={`${base}-${entry.type}`} data-matrix={`${base}:${entry.type}`} className="grid gap-2">
      <EntityHeader summary={page.summary as never} registry={page.registry} locale="en" t={copyOf('en')} />
      <ul aria-label="Sections drawn">{page.sections.filter(section => drawnSections.includes(section.id))
        .map(section => <li key={section.id}>{section.id}</li>)}</ul>
    </section>;
  })}</div>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvasElement.querySelectorAll('[data-matrix]').length).toBe(entries.length);
    // No type, known or not, draws a book's controls on the generic page.
    await expect(canvas.queryAllByRole('button', { name: /^(read|start reading|continue reading)$/i })).toHaveLength(0);
    await expect(canvas.queryAllByRole('link', { name: /^(read|start reading|continue reading)$/i })).toHaveLength(0);
    // Contents, releases and credits belong to their own hosts; the generic page never draws them.
    for (const list of canvas.getAllByRole('list', { name: 'Sections drawn' })) {
      for (const item of within(list).queryAllByRole('listitem')) {
        await expect(['statements', 'relations', 'ratings', 'reviews', 'discussion']).toContain(item.textContent);
      }
    }
  },
};
