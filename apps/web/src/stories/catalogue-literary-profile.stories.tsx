import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useMemo } from 'react';
import { pickText } from '@rezics/composition';
import { LiteraryProfile } from '../features/catalogue/literary-profile-view';
import type { LiteraryType } from '../features/catalogue/literary-profile';
import {
  literaryFixture,
  literaryWorkId,
  literaryRelease,
  type LiteraryScenario,
} from '../kernel/fake/catalogue-literary-profile';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PageStory, PatternStory } from './page';

function LiteraryStory({
  scenario = 'ready',
  type = 'schema:Book',
  editing = false,
  signedOut = false,
  longIdentity = false,
  uncertainCorrection = false,
}: {
  scenario?: LiteraryScenario;
  type?: LiteraryType;
  editing?: boolean;
  signedOut?: boolean;
  longIdentity?: boolean;
  uncertainCorrection?: boolean;
}) {
  const locale = getLocale();
  const fixture = useMemo(() => {
    const value = literaryFixture(scenario, locale, type, editing);
    // Only supplied fixture terms are changed. No title lookup or production behavior is added.
    const current = value.publicRead();
    if (longIdentity) {
      current.subject.labels = {
        en: 'An original literary work with a very long complete title ' + 'Bibliography'.repeat(24),
        ar: 'عمل أدبي أصلي باسم طويل ومراجع كاملة',
      };
      current.subject.descriptions = {
        en: 'A full illustrative bibliographic description. '.repeat(8),
        fr: 'Description conservée même sans nom français.',
      };
      current.subject.aliases = {
        ja: ['長い別名をすべて表示'],
        en: ['An alternative complete work title ' + 'Original'.repeat(24)],
      };
      const load = value.transport.load;
      value.transport.load = async () => {
        const read = await load();
        return read.ok
          ? {
              ...read,
              release: {
                ...read.release,
                types: {
                  ...read.release.types,
                  [type]: {
                    ...read.release.types[type]!,
                    labels: { en: 'A long released literary kind ' + 'Bibliographic'.repeat(20) },
                  },
                },
              },
              current: read.current ? { ...read.current, public: current } : null,
            }
          : read;
      };
    }
    if (uncertainCorrection) value.facts.propose = async () => ({ ok: false, reason: 'uncertain' });
    return value;
  }, [scenario, locale, type, editing, longIdentity, uncertainCorrection]);
  return (
    <PatternStory visitor={signedOut ? 'Signed Out' : 'Signed In'} path="/catalogue/literary">
      <AppShell>
        <LiteraryProfile
          locale={locale}
          session={signedOut ? 'signed-out' : 'signed-in'}
          id={editing ? literaryWorkId : undefined}
          transport={fixture.transport}
          facts={fixture.facts}
          review={fixture.review}
        />
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Catalogue/Book and book-series work editor',
  id: 'pages-catalogue-book-and-book-series-work-editor',
  component: LiteraryStory,
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
          'Released book/series metadata and ordinary request seams. Native binding and visual acceptance are separate; no provider prose, covers or inferred word coverage.',
      },
    },
  },
} satisfies Meta<typeof LiteraryStory>;
export default meta;
type Story = StoryObj<typeof meta>;

async function enterWork(canvasElement: HTMLElement, type = 'schema:Book') {
  const canvas = within(canvasElement);
  await userEvent.selectOptions(await canvas.findByRole('combobox', { name: m.catalogue_create_type() }), type);
  const language = canvas.getByRole('textbox', { name: m.catalogue_create_language() });
  await userEvent.clear(language);
  await userEvent.type(language, 'ja');
  await userEvent.type(canvas.getByRole('textbox', { name: m.catalogue_create_label() }), '原語の作品名');
  if (type === 'schema:Book') {
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.refinement_property() }), 'schema:wordCount');
    await userEvent.click(canvas.getByRole('button', { name: m.correction_add() }));
    await userEvent.type(canvas.getByRole('textbox', { name: m.correction_amount() }), '+12000');
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.correction_unit() }), '1');
  }
  return canvas;
}
async function submit(canvasElement: HTMLElement) {
  const canvas = await enterWork(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
  return canvas;
}
export const Create: Story = {};
export const CurrentBook: Story = { args: { editing: true } };
export const CurrentBookSeries: Story = { args: { editing: true, type: 'schema:BookSeries' } };
export const CreateOriginalLanguageWork: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    const link = await canvas.findByRole('link', { name: m.catalogue_create_open() });
    expect(link.getAttribute('href')).toContain(`/subjects/${literaryWorkId}/`);
    expect(canvas.queryByRole('button', { name: m.catalogue_create_submit() })).toBeNull();
  },
};
export const CreateBookSeries: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await enterWork(canvasElement, 'schema:BookSeries');
    expect(
      canvas.getByRole('combobox', { name: m.refinement_property() }).querySelector('option[value="schema:wordCount"]'),
    ).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
    expect(await canvas.findByRole('link', { name: m.catalogue_create_open() })).toHaveAttribute(
      'href',
      expect.stringContaining(literaryWorkId),
    );
  },
};
export const Loading: Story = { args: { scenario: 'loading' } };
export const Unavailable: Story = { args: { scenario: 'metadata-unavailable' } };
export const NoReleasedProfiles: Story = { args: { scenario: 'empty' } };
export const SignedOut: Story = { args: { signedOut: true } };
export const Denied: Story = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.catalogue_create_denied());
    expect(canvas.getByRole('textbox', { name: m.correction_amount() })).toHaveValue('+12000');
  },
};
export const Stale: Story = {
  args: { scenario: 'stale' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.catalogue_create_conflict());
  },
};
export const Invalid: Story = {
  args: { scenario: 'invalid' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.catalogue_create_invalid());
  },
};
export const Uncertain: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.catalogue_create_uncertain());
    expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_retry() }));
    expect(await canvas.findByRole('link', { name: m.catalogue_create_open() })).toHaveAttribute(
      'href',
      expect.stringContaining(literaryWorkId),
    );
  },
};
export const CreatedReaderUnavailable: Story = {
  args: { scenario: 'reader-unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByText(m.catalogue_create_reader_unavailable())).toBeVisible();
    expect(canvas.queryByRole('link', { name: m.catalogue_create_open() })).toBeNull();
  },
};
export const Concealed: Story = { args: { scenario: 'concealed', editing: true } };
export const ProposeChangedWordCount: Story = {
  args: { editing: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const field = await canvas.findByRole('region', {
      name: pickText(literaryRelease.properties['schema:wordCount']!.labels, getLocale()).text,
    });
    const controls = within(field);
    await userEvent.click(controls.getByRole('button', { name: m.facts_edit_field() }));
    const amount = controls.getByRole('textbox', { name: m.correction_amount() });
    await userEvent.clear(amount);
    await userEvent.type(amount, '+13000');
    await userEvent.click(canvas.getByRole('button', { name: m.facts_submit() }));
    expect(await controls.findByText(m.correction_proposed())).toBeVisible();
    expect(controls.getByRole('link', { name: m.correction_review() }).getAttribute('href')).toContain(
      'candidate=00000000-0000-4000-8000-00000000b002',
    );
  },
};
export const Route: Story = {
  render: () => (
    <PageStory visitor="Signed In" path={`/subjects/${literaryWorkId}/an-original-literary-work/literary`} />
  ),
  globals: {},
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const document = canvasElement.ownerDocument;
    const view = document.defaultView;
    if (!view) throw new Error('Literary profile story requires a browser window.');
    await canvas.findByRole('heading', { level: 1, name: m.literary_title() });

    const article = canvasElement.querySelector('article');
    if (!article) throw new Error('Literary profile article is missing.');
    const phoneWidth = document.documentElement.clientWidth < 768;
    const coarsePointer = view.matchMedia('(pointer: coarse)').matches;
    const touchLayout = phoneWidth || coarsePointer;
    const minimumHeight = touchLayout ? 44 : 32;
    const assertOwnedTarget = async (target: HTMLElement, region: HTMLElement) => {
      const rect = target.getBoundingClientRect();
      const bounds = region.getBoundingClientRect();
      await expect(target).toBeVisible();
      await expect(rect.height).toBeGreaterThanOrEqual(minimumHeight);
      if (touchLayout) await expect(rect.width).toBeGreaterThanOrEqual(44);
      else await expect(rect.height).toBeLessThan(44);
      await expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 1);
      await expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
      await expect(target.scrollWidth).toBeLessThanOrEqual(target.clientWidth + 1);
    };

    const identity = await canvas.findByRole('region', { name: m.literary_identity() });
    await expect(identity.scrollWidth).toBeLessThanOrEqual(identity.clientWidth + 1);
    const identityLinks = within(identity).getAllByRole('link');
    await expect(identityLinks).toHaveLength(2);
    const identityLink = identityLinks[0]!;
    const termsLink = identityLinks[1]!;
    await expect(identityLink).toHaveAttribute('href', expect.stringContaining(literaryWorkId));
    await expect(termsLink).toHaveAttribute('href', expect.stringContaining('/terms'));
    await assertOwnedTarget(identityLink, identity);
    await assertOwnedTarget(termsLink, identity);

    const navigation = article.querySelector('nav');
    if (!navigation) throw new Error('Literary profile navigation is missing.');
    const publicLink = within(navigation).getByRole('link', { name: m.candidate_view_public() });
    const changesLink = within(navigation).getByRole('link', { name: m.changes_title() });
    await assertOwnedTarget(publicLink, navigation);
    await assertOwnedTarget(changesLink, navigation);

    const summaries = Array.from(article.querySelectorAll<HTMLElement>('details > summary'));
    await expect(summaries.length).toBeGreaterThan(0);
    for (const summary of summaries) {
      await expect(summary.tagName).toBe('SUMMARY');
      await assertOwnedTarget(summary, article);
    }

    const summary = summaries[0]!;
    const tabbable = Array.from(
      article.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), summary, input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter(
      (element) =>
        element.getClientRects().length > 0 &&
        (element.tagName === 'SUMMARY' || !element.closest('details:not([open])')),
    );
    const previous = tabbable[tabbable.indexOf(summary) - 1];
    if (!previous) throw new Error('Literary disclosure has no preceding keyboard target.');
    previous.focus();
    await userEvent.tab();
    await expect(summary).toHaveFocus();
    await expect(view.getComputedStyle(summary).outlineWidth).not.toBe('0px');
    await userEvent.keyboard('{Enter}');
    await expect(summary.closest('details')).toHaveAttribute('open', '');
  },
};

// UNRUN: constructed presentation fixtures, with ordinary native-shaped proposal failures.
export const CorrectionLongIdentity: Story = {
  args: { editing: true, longIdentity: true },
  play: ({ canvasElement }) => inspectCorrectionIdentity(canvasElement),
};
export const CorrectionSignedOut: Story = { args: { editing: true, signedOut: true } };
export const CorrectionLoading: Story = { args: { editing: true, scenario: 'loading' } };
export const CorrectionUnavailable: Story = { args: { editing: true, scenario: 'metadata-unavailable' } };
async function correctionFailure(canvasElement: HTMLElement, message: string) {
  const canvas = within(canvasElement);
  const field = within(
    await canvas.findByRole('region', {
      name: pickText(literaryRelease.properties['schema:wordCount']!.labels, getLocale()).text,
    }),
  );
  await userEvent.click(field.getByRole('button', { name: m.facts_edit_field() }));
  const amount = field.getByRole('textbox', { name: m.correction_amount() });
  await userEvent.clear(amount);
  await userEvent.type(amount, '+13000');
  await userEvent.click(canvas.getByRole('button', { name: m.facts_submit() }));
  await expect(await field.findByText(message)).toBeVisible();
  await expect(amount).toHaveValue('+13000');
}
export const CorrectionDenied: Story = {
  args: { editing: true, scenario: 'denied' },
  play: ({ canvasElement }) => correctionFailure(canvasElement, m.correction_denied()),
};
export const CorrectionUncertain: Story = {
  args: { editing: true, uncertainCorrection: true },
  play: ({ canvasElement }) => correctionFailure(canvasElement, m.facts_uncertain()),
};

// UNRUN browser oracles for the ordinary phone390/desktop1280 and locale/theme globals.
async function inspectCorrectionIdentity(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const scope = await canvas.findByText(m.specialist_identity_scope());
  const identity = scope.parentElement!;
  const heading = identity.querySelector('h2')!;
  const reference = canvas.getByText(m.specialist_identity_reference(), { selector: 'summary' });
  const details = reference.closest('details')!;
  await expect(heading).toBeVisible();
  await expect(heading.compareDocumentPosition(reference) & 4).toBeTruthy();
  await expect(details).not.toHaveAttribute('open');
  reference.focus();
  await userEvent.tab();
  await userEvent.tab({ shift: true });
  await expect(reference).toHaveFocus();
  for (let attempt = 0; attempt < 3; attempt++) {
    await userEvent.keyboard('{Enter}');
    await expect(details).toHaveAttribute('open', '');
    await expect(Array.from(details.querySelectorAll('code'), (code) => code.textContent)).toEqual([
      literaryWorkId,
      'schema:Book',
    ]);
    for (const element of [identity, heading, reference, ...details.querySelectorAll<HTMLElement>('dd')]) {
      await expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
    }
    await userEvent.keyboard('{Enter}');
    await expect(details).not.toHaveAttribute('open');
  }
  const names = canvas.getByText(m.specialist_identity_names(), { selector: 'summary' });
  await userEvent.click(names);
  for (const text of names.closest('details')!.querySelectorAll<HTMLElement>('dd')) {
    await expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth + 1);
    await expect(text.className).not.toMatch(/truncate|line-clamp/);
  }
}

// Authored UNRUN. These additions mount the production create family with supplied metadata.
// They add no production producer, request, native authority, or SSR claim.
function initialBibliographyFixture(scenario: LiteraryScenario, locale: string, missingDefinition: boolean) {
  const fixture = literaryFixture(scenario, locale);
  const load = fixture.transport.load;
  const submit = fixture.transport.submit;
  let removed = false;
  fixture.transport.submit = async (command) => {
    const result = await submit(command);
    if (missingDefinition) removed = true;
    return result;
  };
  fixture.transport.load = async () => {
    const read = await load();
    if (!read.ok) return read;
    const properties = { ...read.release.properties };
    const definition = properties['schema:wordCount']!;
    properties['schema:wordCount'] = {
      ...definition,
      labels: {
        ...definition.labels,
        [locale]: `${pickText(definition.labels, locale).text} — ${'完全な書誌情報 Bibliographie'.repeat(14)}`,
      },
      descriptions: {
        ...definition.descriptions,
        [locale]: `${pickText(definition.descriptions ?? {}, locale).text} ${'La description bibliographique complète est conservée. '.repeat(16)}`,
      },
    };
    if (removed) delete properties['schema:wordCount'];
    return { ...read, release: { ...read.release, properties } };
  };
  return fixture;
}

function InitialBibliographyStory({
  pair = false,
  direction,
  scenario = 'ready',
  missingDefinition = false,
}: {
  pair?: boolean;
  direction?: 'rtl';
  scenario?: LiteraryScenario;
  missingDefinition?: boolean;
}) {
  const locale = getLocale();
  const fixtures = useMemo(
    () => Array.from({ length: pair ? 2 : 1 }, () => initialBibliographyFixture(scenario, locale, missingDefinition)),
    [pair, scenario, locale, missingDefinition],
  );
  return (
    <PatternStory visitor="Signed In" path="/catalogue/literary">
      <AppShell>
        <div dir={direction} className="min-w-0 space-y-8">
          {fixtures.map((fixture, index) => (
            <section key={index} aria-label={`Create bibliography ${index + 1}`} className="min-w-0">
              <LiteraryProfile
                locale={locale}
                session="signed-in"
                transport={fixture.transport}
                facts={fixture.facts}
                review={fixture.review}
              />
            </section>
          ))}
        </div>
      </AppShell>
    </PatternStory>
  );
}

function initialBibliographyPanel(scope: HTMLElement) {
  const legend = Array.from(scope.querySelectorAll('legend')).find(
    (element) => element.textContent === m.literary_bibliography(),
  );
  if (!legend?.parentElement) throw new Error('Initial bibliography fieldset is missing.');
  return legend.parentElement as HTMLFieldSetElement;
}

async function addInitialFact(scope: HTMLElement, property: string) {
  const panel = within(initialBibliographyPanel(scope));
  await userEvent.selectOptions(panel.getByRole('combobox', { name: m.refinement_property() }), property);
  await userEvent.click(panel.getByRole('button', { name: m.correction_add() }));
}

async function inspectInitialBibliography(canvasElement: HTMLElement) {
  const canvas = await enterWork(canvasElement);
  const fieldset = initialBibliographyPanel(canvasElement);
  const fact = fieldset.querySelector<HTMLElement>('section[id^="literary-fact-"]')!;
  const heading = within(fact).getByRole('heading', { level: 3 });
  const select = within(fieldset).getByRole('combobox', { name: m.refinement_property() });
  const description = fact.querySelector('p')!;
  const view = canvasElement.ownerDocument.defaultView!;
  const citation = 'https://Example.org/Original%2FSource?language=ja&edition=First#' + 'Bibliographie'.repeat(24);
  await userEvent.type(within(fact).getByRole('textbox', { name: m.correction_url() }), citation);
  await expect(heading).toHaveTextContent('完全な書誌情報 Bibliographie'.repeat(14));
  await expect(heading).toHaveAttribute('data-content-item-slot', 'title');
  await expect(description).toHaveTextContent(
    'La description bibliographique complète est conservée. '.repeat(16).trim(),
  );
  await expect(fact.closest('form')).toBe(fieldset.closest('form'));
  await expect(fact.closest('fieldset')).toBe(fieldset);
  await expect(fieldset.firstElementChild?.tagName).toBe('LEGEND');
  await expect(fact.querySelector('h4')).toHaveTextContent(m.correction_references());
  await expect(fact.querySelector('a,summary')).toBeNull();
  await expect(canvas.getByRole('textbox', { name: m.correction_url() })).toHaveValue(citation);
  const label = Array.from(fieldset.querySelectorAll<HTMLLabelElement>('label')).find(
    (element) => element.htmlFor === select.id,
  )!;
  await expect(label.control).toBe(select);
  const bounds = fieldset.getBoundingClientRect();
  const targets = [
    select,
    within(fieldset).getByRole('button', { name: m.correction_add() }),
    within(fact).getByRole('button', { name: m.literary_remove_fact() }),
  ];
  for (const target of targets) {
    const rect = target.getBoundingClientRect();
    await expect(target).toBeVisible();
    await expect(rect.height).toBeGreaterThanOrEqual(44);
    await expect(rect.width).toBeGreaterThanOrEqual(44);
    await expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 1);
    await expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
    await expect(target.scrollWidth).toBeLessThanOrEqual(target.clientWidth + 1);
  }
  for (const text of [fieldset, fact, heading, description]) {
    await expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth + 1);
    await expect(text.className).not.toMatch(/truncate|line-clamp/);
  }
  select.focus();
  await userEvent.tab({ shift: true });
  await userEvent.tab();
  await expect(select).toHaveFocus();
  await expect(view.getComputedStyle(select).outlineWidth).not.toBe('0px');
  await userEvent.selectOptions(select, 'schema:inLanguage');
  await userEvent.tab();
  const add = within(fieldset).getByRole('button', { name: m.correction_add() });
  await expect(add).toHaveFocus();
  await expect(view.getComputedStyle(add).outlineWidth).not.toBe('0px');
  await userEvent.keyboard('{Enter}');
  const added = fieldset.querySelectorAll<HTMLElement>('section[id^="literary-fact-"]')[1]!;
  await expect(within(added).getByRole('heading', { level: 3 })).toHaveTextContent(
    pickText(literaryRelease.properties['schema:inLanguage']!.labels, getLocale()).text,
  );
  const remove = within(added).getByRole('button', { name: m.literary_remove_fact() });
  const citationInput = within(added).getByRole('textbox', { name: m.correction_url() });
  citationInput.focus();
  await userEvent.tab();
  await expect(remove).toHaveFocus();
  await expect(view.getComputedStyle(remove).outlineWidth).not.toBe('0px');
  await userEvent.keyboard('{Enter}');
  await expect(fieldset.querySelectorAll('h3')).toHaveLength(1);
}

export const InitialBibliography: Story = {
  render: () => <InitialBibliographyStory />,
  globals: {},
  play: ({ canvasElement }) => inspectInitialBibliography(canvasElement),
};
export const InitialBibliographyRTL: Story = {
  render: () => <InitialBibliographyStory direction="rtl" />,
  globals: {},
  play: ({ canvasElement }) => inspectInitialBibliography(canvasElement),
};
export const InitialBibliographyDesktop: Story = {
  tags: ['!dev'],
  render: () => <InitialBibliographyStory />,
  globals: {},
  play: ({ canvasElement }) => inspectInitialBibliography(canvasElement),
};
export const InitialBibliographyPhoneRTL: Story = {
  tags: ['!dev'],
  render: () => <InitialBibliographyStory direction="rtl" />,
  globals: {},
  play: ({ canvasElement }) => inspectInitialBibliography(canvasElement),
};
export const InitialBibliographyIndependent: Story = {
  render: () => <InitialBibliographyStory pair />,
  globals: {},
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const regions = [
      canvas.getByRole('region', { name: 'Create bibliography 1' }),
      canvas.getByRole('region', { name: 'Create bibliography 2' }),
    ];
    for (const region of regions) {
      const type = await within(region).findByRole('combobox');
      await userEvent.selectOptions(type, 'schema:Book');
    }
    const selectors = regions.map((region) =>
      within(initialBibliographyPanel(region)).getByRole('combobox', {
        name: m.refinement_property(),
      }),
    );
    await expect(selectors[0]!.id).not.toBe(selectors[1]!.id);
    for (const [index, region] of regions.entries()) {
      const label = Array.from(region.querySelectorAll<HTMLLabelElement>('label')).find(
        (element) => element.htmlFor === selectors[index]!.id,
      )!;
      await expect(label.control).toBe(selectors[index]);
      await expect(canvasElement.ownerDocument.getElementById(label.htmlFor)).toBe(selectors[index]);
    }
    await userEvent.selectOptions(selectors[0]!, 'schema:wordCount');
    await expect(selectors[1]).toHaveValue('');
    await userEvent.click(
      within(initialBibliographyPanel(regions[0]!)).getByRole('button', { name: m.correction_add() }),
    );
    await expect(regions[0]!.querySelectorAll('h3')).toHaveLength(1);
    await expect(regions[1]!.querySelectorAll('h3')).toHaveLength(0);
    await addInitialFact(regions[1]!, 'schema:inLanguage');
    await expect(regions[1]!.querySelectorAll('h3')).toHaveLength(1);
  },
};
export const InitialBibliographyDraftsAndLimit: Story = {
  render: () => <InitialBibliographyStory />,
  play: async ({ canvasElement }) => {
    const canvas = await enterWork(canvasElement);
    const type = canvas.getByRole('combobox', { name: m.catalogue_create_type() });
    const bookRow = canvasElement.querySelector('section[id^="literary-fact-"]')!;
    await userEvent.selectOptions(type, 'schema:BookSeries');
    await expect(canvas.queryByRole('textbox', { name: m.correction_amount() })).toBeNull();
    await addInitialFact(canvasElement, 'wdt:P2635');
    await userEvent.type(canvas.getByRole('textbox', { name: m.correction_amount() }), '+6');
    const seriesRow = canvasElement.querySelector('section[id^="literary-fact-"]')!;
    await userEvent.selectOptions(type, 'schema:Book');
    await expect(canvasElement.querySelector('section[id^="literary-fact-"]')!.id).toBe(bookRow.id);
    await expect(canvas.getByRole('textbox', { name: m.correction_amount() })).toHaveValue('+12000');
    const fieldset = initialBibliographyPanel(canvasElement);
    const property = within(fieldset).getByRole('combobox', { name: m.refinement_property() });
    await expect(property.querySelector('option[value="schema:wordCount"]')).toBeNull();
    for (let index = 1; index < 12; index++) await addInitialFact(canvasElement, 'schema:inLanguage');
    await userEvent.selectOptions(property, 'schema:inLanguage');
    await expect(fieldset.querySelectorAll('h3')).toHaveLength(12);
    await expect(within(fieldset).getByRole('button', { name: m.correction_add() })).toBeDisabled();
    await userEvent.click(within(fieldset).getAllByRole('button', { name: m.literary_remove_fact() })[0]!);
    await expect(fieldset.querySelectorAll('h3')).toHaveLength(11);
    await expect(within(fieldset).getByRole('button', { name: m.correction_add() })).toBeEnabled();
    await expect(property.querySelector('option[value="schema:wordCount"]')).not.toBeNull();
    await userEvent.selectOptions(type, 'schema:BookSeries');
    await expect(canvasElement.querySelector('section[id^="literary-fact-"]')!.id).toBe(seriesRow.id);
    await expect(canvas.getByRole('textbox', { name: m.correction_amount() })).toHaveValue('+6');
  },
};
export const InitialBibliographyMissingDefinition: Story = {
  render: () => <InitialBibliographyStory scenario="invalid" missingDefinition />,
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    await expect(await canvas.findByText(m.correction_stale())).toBeVisible();
    const fieldset = initialBibliographyPanel(canvasElement);
    await expect(fieldset.querySelector('h3')).toBeNull();
    await userEvent.click(within(fieldset).getByRole('button', { name: m.literary_remove_fact() }));
    await expect(within(fieldset).queryByText(m.correction_stale())).toBeNull();
    await expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveValue('原語の作品名');
  },
};
export const InitialBibliographyUncertainReference: Story = {
  render: () => <InitialBibliographyStory scenario="uncertain" />,
  play: async ({ canvasElement }) => {
    const canvas = await enterWork(canvasElement);
    const citation = 'https://Example.org/Original%2FSource?edition=First#Original';
    await userEvent.type(canvas.getByRole('textbox', { name: m.correction_url() }), citation);
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
    await expect(await canvas.findByText(m.catalogue_create_uncertain())).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: m.correction_url() })).toHaveValue(citation);
    await expect(canvas.getByRole('textbox', { name: m.correction_url() })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_retry() }));
    await expect(await canvas.findByRole('link', { name: m.catalogue_create_open() })).toHaveAttribute(
      'href',
      expect.stringContaining(literaryWorkId),
    );
  },
};

async function initialReferenceFailure(canvasElement: HTMLElement, message: string) {
  const canvas = await enterWork(canvasElement);
  const citation = 'https://Example.org/Original%2FSource?edition=First#Original';
  await userEvent.type(canvas.getByRole('textbox', { name: m.correction_url() }), citation);
  await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
  await expect(await canvas.findByText(message)).toBeVisible();
  await expect(canvas.getByRole('textbox', { name: m.correction_amount() })).toHaveValue('+12000');
  await expect(canvas.getByRole('textbox', { name: m.correction_url() })).toHaveValue(citation);
  await expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveValue('原語の作品名');
}
export const InitialBibliographyDeniedReference: Story = {
  render: () => <InitialBibliographyStory scenario="denied" />,
  play: ({ canvasElement }) => initialReferenceFailure(canvasElement, m.catalogue_create_denied()),
};
export const InitialBibliographyStaleReference: Story = {
  render: () => <InitialBibliographyStory scenario="stale" />,
  play: async ({ canvasElement }) => {
    await initialReferenceFailure(canvasElement, m.catalogue_create_conflict());
    await expect(within(canvasElement).getByRole('textbox', { name: m.correction_url() })).toBeDisabled();
  },
};
export const InitialBibliographyReaderUnavailable: Story = {
  render: () => <InitialBibliographyStory scenario="reader-unavailable" />,
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    await expect(await canvas.findByText(m.catalogue_create_reader_unavailable())).toBeVisible();
    await expect(canvas.queryByRole('link', { name: m.catalogue_create_open() })).toBeNull();
    await expect(canvas.queryByRole('button', { name: m.catalogue_create_submit() })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_retry() }));
    await expect(await canvas.findByText(m.catalogue_create_reader_unavailable())).toBeVisible();
  },
};
