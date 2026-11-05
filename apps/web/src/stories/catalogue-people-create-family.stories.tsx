import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useMemo, useState } from 'react';
import { PeopleProfileEditor } from '../features/catalogue/people-profile-view';
import { peopleProfiles, type PeopleRead } from '../features/catalogue/people-profile';
import { definitionText } from '../features/catalogue/definition-guide';
import { peopleProfileFixture, type PeopleScenario } from '../kernel/fake/catalogue-people-profile';
import { CandidateReaderBoundary } from '../subject/candidate-lifetime';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import definitions from '../kernel/recorded/definitions-release.json';

const longName = `URL 人物 조직 ميرا ${'IdentiteSansEspaces'.repeat(14)}`;
const longMeaning = `Complete supplied field meaning 人物 조직 ميرا ${'DescriptionSansEspaces'.repeat(18)}`;
const longUrl = `https://example.org/${'sourceSansEspaces'.repeat(24)}`;
const longCitation = `https://example.org/${'credit/'.repeat(36)}evidence`;
type FamilyType = 'schema:Person' | 'schema:Organization';
type Variant = 'released' | 'long' | 'removed';
const releasedName = (property: string) =>
  definitionText(
    (definitions.release.properties as Record<string, { labels: Record<string, string> }>)[property]?.labels,
    getLocale(),
  ).text;
const fieldName = (property: string, long = false) =>
  property === 'schema:url' && long ? longName : releasedName(property);

function FamilyInstance({
  scenario,
  variant,
  session,
}: {
  scenario: PeopleScenario;
  variant: Variant;
  session: 'signed-in' | 'signed-out';
}) {
  const locale = getLocale();
  const fixture = useMemo(() => {
    const fixture = peopleProfileFixture(scenario, locale);
    if (variant === 'long') {
      fixture.release.properties['schema:url']!.labels[locale] = longName;
      fixture.release.properties['schema:url']!.descriptions = { [locale]: longMeaning };
    }
    const load = fixture.transport.load;
    let loads = 0;
    fixture.transport = {
      ...fixture.transport,
      load: async (): Promise<PeopleRead> => {
        const read = await load();
        if (!read.ok || variant !== 'removed' || ++loads === 1) return read;
        const next = structuredClone(read);
        delete next.release.properties['schema:url'];
        next.profiles = peopleProfiles(next.release, locale);
        return next;
      },
      ...(variant === 'removed'
        ? {
            create: async () => ({
              ok: false as const,
              reason: 'invalid' as const,
              refreshDefinitions: true,
              errors: [{ pointer: '/statements/schema:url/0/value/content', code: 'unsupported' as const }],
            }),
          }
        : {}),
    };
    return fixture;
  }, [scenario, variant, locale]);
  return (
    <PeopleProfileEditor
      locale={locale}
      session={session}
      transport={fixture.transport}
      propose={fixture.propose}
      review={fixture.review}
      onNavigate={() => {}}
    />
  );
}

function CreateFamilyStory({
  scenario = 'ready',
  variant = 'released',
  independent = false,
  rtl = false,
  retire = false,
}: {
  scenario?: PeopleScenario;
  variant?: Variant;
  independent?: boolean;
  rtl?: boolean;
  retire?: boolean;
}) {
  const [retired, setRetired] = useState(false);
  const session = retired ? 'signed-out' : 'signed-in';
  return (
    <PatternStory visitor="Signed In" path="/catalogue/people">
      <AppShell>
        <div dir={rtl ? 'rtl' : 'ltr'} className="min-w-0 space-y-8">
          {retire && (
            <button
              type="button"
              className="min-h-11 underline focus-visible:outline-2"
              onClick={() => setRetired(true)}
            >
              {m.account_sign_out()}
            </button>
          )}
          <CandidateReaderBoundary
            observed={
              retired
                ? { state: 'signed-out', csrfToken: null }
                : { state: 'signed-in', subject: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10', csrfToken: 'story-csrf-token' }
            }
            address="people-create-family-story"
          >
            <div data-example="first" className="min-w-0">
              <FamilyInstance scenario={scenario} variant={variant} session={session} />
            </div>
            {independent && (
              <div data-example="second" className="min-w-0">
                <FamilyInstance scenario="ready" variant={variant} session={session} />
              </div>
            )}
          </CandidateReaderBoundary>
        </div>
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Catalogue/People creation field family',
  component: CreateFamilyStory,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
    docs: {
      description: {
        component:
          'UNRUN: whole default Person/Organization creation over the existing generated-request fixture. Long metadata and removed-definition responses are explicit supplied presentation examples. Plays author native keyboard/focus and real browser geometry assertions, not native, SSR, hydration or publication proof. Original People profile stories and oracles remain unchanged.',
      },
    },
  },
} satisfies Meta<typeof CreateFamilyStory>;
export default meta;
type Story = StoryObj<typeof meta>;

const first = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-example="first"]')!;
const fact = (root: HTMLElement, property: string) =>
  root.querySelector<HTMLElement>(`fieldset[id="people-fact-${property}"]`)!;
async function select(root: HTMLElement, type: FamilyType) {
  const canvas = within(root);
  await userEvent.selectOptions(await canvas.findByRole('combobox', { name: m.catalogue_create_type() }), type);
}
async function add(root: HTMLElement, property: string, long = false) {
  const button = within(root).getByRole('button', {
    name: m.people_profile_add_fact({ field: fieldName(property, long) }),
  });
  await expect(button).toHaveAttribute('type', 'button');
  button.focus();
  await expect(button).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  return fact(root, property);
}
async function setValue(root: HTMLElement, property: string, text: string) {
  const datatype = (definitions.release.properties as Record<string, { datatype: string }>)[property]!.datatype;
  const input = within(fact(root, property)).getAllByRole('textbox', {
    name: datatype === 'url' ? m.correction_url() : m.correction_value(),
  })[0]!;
  await userEvent.clear(input);
  await userEvent.type(input, text);
  return input;
}
function citation(root: HTMLElement, property: string) {
  return within(within(fact(root, property)).getByRole('group', { name: `${m.correction_references()} 1` })).getByRole(
    'textbox',
    { name: m.correction_url() },
  );
}
async function confirm(root: HTMLElement) {
  await userEvent.click(within(root).getByRole('button', { name: m.catalogue_create_submit() }));
  if (root.querySelector('[data-people-create-review]'))
    await userEvent.click(within(root).getByRole('button', { name: m.catalogue_create_submit() }));
}
async function setTerms(root: HTMLElement) {
  const canvas = within(root);
  const language = canvas.getByRole('textbox', { name: m.catalogue_create_language() });
  await userEvent.clear(language);
  await userEvent.type(language, 'en');
  await userEvent.type(canvas.getByRole('textbox', { name: m.catalogue_create_label() }), 'Supplied family example');
}
async function bounds(target: HTMLElement, region: HTMLElement) {
  const view = target.ownerDocument.defaultView!;
  const touch = target.ownerDocument.documentElement.clientWidth < 768 || view.matchMedia('(pointer: coarse)').matches;
  const rect = target.getBoundingClientRect();
  const parent = region.getBoundingClientRect();
  await expect(target).toBeVisible();
  await expect(rect.height).toBeGreaterThanOrEqual(touch ? 44 : 32);
  if (touch) await expect(rect.width).toBeGreaterThanOrEqual(44);
  await expect(rect.left).toBeGreaterThanOrEqual(parent.left - 1);
  await expect(rect.right).toBeLessThanOrEqual(parent.right + 1);
  // Native single-line inputs scroll their text internally; their full exact values remain editable.
  if (!target.matches('input')) {
    await expect(target.scrollWidth).toBeLessThanOrEqual(target.clientWidth + 1);
    await expect(target.scrollHeight).toBeLessThanOrEqual(target.clientHeight + 1);
  }
}
async function family(root: HTMLElement, type: FamilyType, long = false) {
  await select(root, type);
  const canvas = within(root);
  const section = canvas.getByRole('heading', { level: 2, name: m.people_profile_initial() }).closest('section')!;
  await expect(section.querySelectorAll('fieldset')).toHaveLength(0);
  await setTerms(root);
  const properties =
    type === 'schema:Person'
      ? ['schema:birthDate', 'schema:deathDate', 'schema:sameAs', 'schema:url', 'wdt:P3180', 'wdt:P6298', 'wdt:P648']
      : ['schema:sameAs', 'schema:url', 'wdt:P3180'];
  for (const property of properties) {
    const addButton = canvas.getByRole('button', {
      name: m.people_profile_add_fact({ field: fieldName(property, long) }),
    });
    await bounds(addButton, section);
    // The original short-label fine-pointer target remains compact; long labels can wrap fully.
    if (
      !(property === 'schema:url' && long) &&
      root.ownerDocument.defaultView!.matchMedia('(min-width: 768px) and (pointer: fine)').matches
    )
      await expect(addButton.getBoundingClientRect().height).toBeLessThan(44);
    const fieldset = await add(root, property, long);
    const group = within(fieldset);
    const heading = group.getByRole('heading', { name: fieldName(property, long), level: 3 });
    await expect(heading.closest('legend')?.parentElement).toBe(fieldset);
    await expect(fieldset.closest('section')).toBe(section);
    await expect(fieldset.querySelector('[data-slot="people-initial-fact"]')).not.toBeNull();
    await expect(fieldset.querySelector('[data-slot="people-initial-fact"]')).not.toBeNull();
    const datatype = (definitions.release.properties as Record<string, { datatype: string }>)[property]!.datatype;
    let valueControl: HTMLElement | undefined;
    let valueText: string | undefined;
    if (datatype === 'time') {
      await userEvent.selectOptions(group.getByRole('combobox', { name: m.correction_precision() }), '11');
      await userEvent.type(group.getByRole('textbox', { name: m.correction_year() }), '1980');
      await userEvent.type(group.getByRole('spinbutton', { name: m.correction_month() }), '4');
      await userEvent.type(group.getByRole('spinbutton', { name: m.correction_day() }), '3');
    } else {
      valueText =
        property === 'wdt:P3180'
          ? 'p123'
          : property === 'wdt:P6298'
            ? '123'
            : property === 'wdt:P648'
              ? 'OL23919A'
              : longUrl;
      valueControl = await setValue(root, property, valueText);
    }
    const cite = citation(root, property);
    await userEvent.type(cite, longCitation);
    await expect(cite).toHaveValue(longCitation);
    const addPart = within(fieldset).getByRole('combobox', { name: m.correction_add_part() });
    const remove = group.getByRole('button', { name: m.people_profile_remove_fact() });
    cite.focus();
    await expect(cite).toHaveFocus();
    await userEvent.keyboard('{Tab}');
    await expect(addPart).toHaveFocus();
    const tabStops: Element[] = [addPart];
    for (let tabs = 0; root.ownerDocument.activeElement !== remove && tabs < 12; tabs++) {
      await userEvent.keyboard('{Tab}');
      if (root.ownerDocument.activeElement) tabStops.push(root.ownerDocument.activeElement);
    }
    await expect(tabStops.length).toBeGreaterThan(1);
    await expect(tabStops.at(-1)).toBe(remove);
    await expect(remove).toHaveFocus();
    await expect(cite).toHaveValue(longCitation);
    if (valueControl && valueText) await expect(valueControl).toHaveValue(valueText);
    await bounds(cite, fieldset);
    await expect(remove).toHaveAttribute('type', 'button');
    const focus = root.ownerDocument.defaultView!.getComputedStyle(remove);
    await expect(focus.outlineWidth !== '0px' || focus.boxShadow !== 'none').toBe(true);
    await bounds(remove, fieldset);
    const description =
      long && property === 'schema:url'
        ? longMeaning
        : definitionText(
            (definitions.release.properties as Record<string, { descriptions?: Record<string, string> }>)[property]
              ?.descriptions,
            getLocale(),
          ).text;
    await expect(fieldset).toHaveTextContent(description);
    for (const text of [heading, ...fieldset.querySelectorAll('p, label')]) {
      await expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth + 1);
      await expect(text.className).not.toMatch(/truncate|line-clamp/);
    }
  }
  await expect(section.querySelectorAll('fieldset')).toHaveLength(properties.length);
  const same = fact(root, 'schema:sameAs');
  await userEvent.click(within(same).getByRole('button', { name: m.people_profile_remove_fact() }));
  await expect(fact(root, 'schema:sameAs')).toBeNull();
  await add(root, 'schema:sameAs', long);
  await expect(
    within(fact(root, 'schema:sameAs')).getAllByRole('textbox', { name: m.correction_url() })[0],
  ).toHaveValue('');
  await setValue(root, 'schema:sameAs', longUrl);
  await expect(
    within(section).queryByRole('button', { name: m.people_profile_add_fact({ field: releasedName('schema:image') }) }),
  ).toBeNull();
  await expect(section).toHaveTextContent(m.people_profile_unsupported());
  await expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);
}

// Every new play and viewport assertion below is authored UNRUN.
export const PersonInitialFamily: Story = {
  play: async ({ canvasElement }) => family(first(canvasElement), 'schema:Person'),
};
export const OrganizationInitialFamily: Story = {
  play: async ({ canvasElement }) => family(first(canvasElement), 'schema:Organization'),
};
export const PersonPhone390: Story = {
  ...PersonInitialFamily,
  globals: { viewport: { value: 'phone390', isRotated: false } },
};
export const OrganizationDesktop1280: Story = {
  ...OrganizationInitialFamily,
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
};
export const LongPersonPhone390RTL: Story = {
  args: { variant: 'long', rtl: true },
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => family(first(canvasElement), 'schema:Person', true),
};
export const LongOrganizationDesktop1280RTL: Story = {
  args: { variant: 'long', rtl: true },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  play: async ({ canvasElement }) => family(first(canvasElement), 'schema:Organization', true),
};
export const IndependentSuppliedInstances: Story = {
  args: { independent: true },
  play: async ({ canvasElement }) => {
    const a = first(canvasElement);
    const b = canvasElement.querySelector<HTMLElement>('[data-example="second"]')!;
    await select(a, 'schema:Person');
    await select(b, 'schema:Organization');
    await add(a, 'schema:url');
    await add(b, 'schema:url');
    await setValue(a, 'schema:url', 'https://example.org/person');
    await setValue(b, 'schema:url', 'https://example.org/organization');
    await select(a, 'schema:Organization');
    await expect(fact(a, 'schema:url')).toBeNull();
    await add(a, 'schema:url');
    await setValue(a, 'schema:url', 'https://example.org/other-type');
    await select(a, 'schema:Person');
    await expect(within(fact(a, 'schema:url')).getAllByRole('textbox', { name: m.correction_url() })[0]).toHaveValue(
      'https://example.org/person',
    );
    await expect(within(fact(b, 'schema:url')).getAllByRole('textbox', { name: m.correction_url() })[0]).toHaveValue(
      'https://example.org/organization',
    );
  },
};
async function submitUrl(root: HTMLElement) {
  await select(root, 'schema:Organization');
  await setTerms(root);
  await add(root, 'schema:url');
  await setValue(root, 'schema:url', longUrl);
  await userEvent.type(citation(root, 'schema:url'), longCitation);
  await confirm(root);
}
export const CompleteDeliberateCreation: Story = {
  play: async ({ canvasElement }) => {
    const root = first(canvasElement);
    await family(root, 'schema:Person');
    await confirm(root);
    await expect(within(root).findByRole('link', { name: m.catalogue_create_open() })).resolves.toBeVisible();
  },
};
export const InvalidNativeAnchorFocus: Story = {
  play: async ({ canvasElement }) => {
    const root = first(canvasElement);
    await select(root, 'schema:Person');
    await setTerms(root);
    await add(root, 'wdt:P648');
    await setValue(root, 'wdt:P648', 'invalid-identifier');
    await userEvent.click(within(root).getByRole('button', { name: m.catalogue_create_submit() }));
    const link = await within(root).findByRole('link', { name: releasedName('wdt:P648') });
    await expect(link).toHaveAttribute('href', `#${encodeURIComponent('people-fact-wdt:P648')}`);
    await userEvent.click(link);
    await expect(
      within(fact(root, 'wdt:P648')).getByRole('combobox', { name: m.correction_value_state() }),
    ).toHaveFocus();
  },
};
export const RemovedDefinitionRetainsCitation: Story = {
  args: { variant: 'removed' },
  play: async ({ canvasElement }) => {
    const root = first(canvasElement);
    await submitUrl(root);
    const group = within(fact(root, 'schema:url'));
    await expect(group.findByText(m.correction_stale())).resolves.toBeVisible();
    await expect(group.getByRole('heading', { level: 3 })).toHaveTextContent(m.candidate_value_unavailable());
    await expect(group.getByText(longCitation, { exact: false })).toBeVisible();
    await userEvent.click(group.getByRole('button', { name: m.people_profile_remove_fact() }));
    await expect(fact(root, 'schema:url')).toBeNull();
  },
};
export const DeniedRetainsFamily: Story = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    const root = first(canvasElement);
    await submitUrl(root);
    await expect(within(root).findByText(m.catalogue_create_denied())).resolves.toBeVisible();
    await expect(within(fact(root, 'schema:url')).getAllByRole('textbox', { name: m.correction_url() })[0]).toHaveValue(
      longUrl,
    );
  },
};
export const UncertainOriginalReplay: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const root = first(canvasElement);
    await submitUrl(root);
    await expect(within(root).findByText(m.catalogue_create_uncertain())).resolves.toBeVisible();
    await expect(fact(root, 'schema:url')).toBeDisabled();
    await expect(
      within(fact(root, 'schema:url')).getAllByRole('textbox', { name: m.correction_url() })[0],
    ).toBeDisabled();
    await userEvent.click(within(root).getByRole('button', { name: m.catalogue_create_retry() }));
    await expect(within(root).findByRole('link', { name: m.catalogue_create_open() })).resolves.toBeVisible();
  },
};
export const EmptyReleasedTypes: Story = { args: { scenario: 'empty' } };
export const StaleReleasedMetadata: Story = { args: { scenario: 'stale' } };
export const UnavailableMetadata: Story = { args: { scenario: 'unavailable' } };
export const PreparingMetadata: Story = { args: { scenario: 'loading' } };
export const CreatedReaderUnavailable: Story = {
  args: { scenario: 'reader-unavailable' },
  play: async ({ canvasElement }) => {
    const root = first(canvasElement);
    await submitUrl(root);
    await expect(within(root).findByText(m.catalogue_create_reader_unavailable())).resolves.toBeVisible();
  },
};
export const CreatedReaderConcealed: Story = {
  args: { scenario: 'concealed' },
  play: async ({ canvasElement }) => {
    const root = first(canvasElement);
    await submitUrl(root);
    await expect(within(root).findByText(m.catalogue_create_concealed())).resolves.toBeVisible();
  },
};
export const CreationReaderRetirement: Story = {
  args: { retire: true },
  play: async ({ canvasElement }) => {
    const root = first(canvasElement);
    await select(root, 'schema:Person');
    await setTerms(root);
    await add(root, 'schema:url');
    await setValue(root, 'schema:url', longUrl);
    await userEvent.click(within(canvasElement).getByRole('button', { name: m.account_sign_out() }));
    await expect(within(first(canvasElement)).findByText(m.catalogue_create_signed_out())).resolves.toBeVisible();
    await waitFor(() =>
      expect(within(first(canvasElement)).getByRole('button', { name: m.catalogue_create_submit() })).toBeDisabled(),
    );
    await expect(first(canvasElement).innerHTML).not.toContain(longUrl);
  },
};

export const PersonDesktop1280: Story = {
  ...PersonInitialFamily,
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
};
export const OrganizationPhone390: Story = {
  ...OrganizationInitialFamily,
  globals: { viewport: { value: 'phone390', isRotated: false } },
};
export const LongPersonDesktop1280RTL: Story = {
  ...LongPersonPhone390RTL,
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
};
export const LongOrganizationPhone390RTL: Story = {
  ...LongOrganizationDesktop1280RTL,
  globals: { viewport: { value: 'phone390', isRotated: false } },
};
