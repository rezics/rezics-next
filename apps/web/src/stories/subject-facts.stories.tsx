import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { pickText } from '@rezics/composition';
import { SubjectFacts } from '../features/catalogue/subject-facts-view';
import { subjectFactsFixture } from '../kernel/fake/subject-facts';
import type { StatementScenario } from '../kernel/fake/catalogue-statements';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import definitions from '../kernel/recorded/definitions-release.json';
import { identifiersProfileFixture, identifiersCitation } from '../kernel/fake/catalogue-identifiers-profile';

type Scenario = StatementScenario | 'partial' | 'loading' | 'empty' | 'read-denied' | 'read-unavailable';
function Workspace({ scenario }: { scenario: Scenario }) {
  const locale = getLocale();
  const fixture = useMemo(
    () =>
      subjectFactsFixture(
        ['loading', 'empty', 'read-denied', 'read-unavailable'].includes(scenario)
          ? 'ready'
          : (scenario as StatementScenario | 'partial'),
        locale,
      ),
    [scenario, locale],
  );
  const query = useQuery({
    queryKey: ['subject-facts-story', scenario, locale],
    retry: false,
    queryFn: async () => {
      if (scenario === 'loading') return new Promise<never>(() => {});
      if (scenario === 'read-denied') return { ok: false, reason: 'denied' } as const;
      if (scenario === 'read-unavailable') return { ok: false, reason: 'unavailable' } as const;
      const result = await fixture.transport.read();
      if (scenario === 'empty' && result.ok) {
        result.release = structuredClone(result.release);
        result.release.types[result.public.subject.type]!.properties = [];
      }
      return result;
    },
  });
  if (!query.data)
    return (
      <p role="status" className="p-6">
        {m.candidate_loading()}
      </p>
    );
  return <SubjectFacts initial={query.data} locale={locale} transport={fixture.transport} review={fixture.review} />;
}
function Example({ scenario = 'ready' }: { scenario?: Scenario }) {
  return (
    <PatternStory visitor="Signed In">
      <AppShell>
        <Workspace scenario={scenario} />
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Catalogue/Edit facts',
  component: Example,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The canonical subject’s multi-field workspace reuses the scalar editor controls and existing native-shaped proposal/review seam. Each included changed field keeps its own request and outcome. The stories demonstrate interface behavior; integrated native outcome verification, Web visual review and Root screenshots remain pending. Use locale, theme and viewport globals.',
      },
    },
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

async function editFields(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const locale = getLocale();
  const name = (property: 'schema:datePublished' | 'schema:inLanguage') =>
    pickText(definitions.release.properties[property].labels, locale).text;
  const date = within(await canvas.findByRole('region', { name: name('schema:datePublished') }));
  await userEvent.click(date.getByRole('button', { name: m.facts_edit_field() }));
  const year = date.getByRole('textbox', { name: m.correction_year() });
  await userEvent.clear(year);
  await userEvent.type(year, '1946');
  const language = within(canvas.getByRole('region', { name: name('schema:inLanguage') }));
  await userEvent.selectOptions(
    language.getByRole('combobox', { name: m.facts_choose_value() }),
    language.getByRole('option', { name: m.facts_selected_value({ number: 1 }) }),
  );
  await userEvent.click(language.getByRole('button', { name: m.facts_edit_field() }));
  // Value language is authored data; changing the UI locale never changes this field.
  const value = language.getAllByRole('textbox', { name: m.correction_value() })[0]!;
  await userEvent.clear(value);
  await userEvent.type(value, 'de');
  return canvas;
}
async function submitFields(canvasElement: HTMLElement) {
  const canvas = await editFields(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.facts_submit() }));
  return canvas;
}
export const Current: Story = {};
export const ExactCurrentValue: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const label = pickText(definitions.release.properties['schema:inLanguage'].labels, getLocale()).text;
    const field = within(await canvas.findByRole('region', { name: label }));
    const select = field.getByRole('combobox', { name: m.facts_choose_value() });
    await expect(select).toHaveAccessibleName(m.facts_choose_value());
    await expect(field.getByRole('button', { name: m.facts_edit_field() })).toBeDisabled();
    await userEvent.selectOptions(select, field.getByRole('option', { name: m.facts_selected_value({ number: 2 }) }));
    await userEvent.click(field.getByRole('button', { name: m.facts_edit_field() }));
    await expect(field.getAllByRole('textbox', { name: m.correction_value() })[0]!).toHaveValue('fr');
  },
};
export const Loading: Story = { args: { scenario: 'loading' } };
export const Empty: Story = { args: { scenario: 'empty' } };
export const Denied: Story = { args: { scenario: 'read-denied' } };
export const Unavailable: Story = {
  args: { scenario: 'read-unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.correction_reload() }));
    await expect(canvas.findByRole('button', { name: m.facts_submit() })).resolves.toBeVisible();
  },
};
export const Editing: Story = {
  play: async ({ canvasElement }) => {
    await editFields(canvasElement);
  },
};
export const Unchanged: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const label = pickText(definitions.release.properties['schema:datePublished'].labels, getLocale()).text;
    const date = within(await canvas.findByRole('region', { name: label }));
    await userEvent.click(date.getByRole('button', { name: m.facts_edit_field() }));
    await expect(canvas.getByRole('button', { name: m.facts_submit() })).toBeDisabled();
    await expect(date.getByText(m.facts_unchanged())).toBeVisible();
  },
};
export const Submitted: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await submitFields(canvasElement);
    await expect(canvas.findByText(m.facts_results({ count: 2 }))).resolves.toBeVisible();
    const links = canvas.getAllByRole('link', { name: m.correction_review() });
    await userEvent.click(links[0]!);
    await expect(canvas.findByRole('heading', { name: m.candidate_proposed() })).resolves.toBeVisible();
    await expect(canvas.findByRole('heading', { name: m.candidate_title() })).resolves.toBeVisible();
  },
};
export const PartialResults: Story = {
  args: { scenario: 'partial' },
  play: async ({ canvasElement }) => {
    const canvas = await submitFields(canvasElement);
    await expect(canvas.findByText(m.facts_results({ count: 1 }))).resolves.toBeVisible();
    await expect(canvas.findByText(m.correction_denied())).resolves.toBeVisible();
  },
};
export const Conflict: Story = {
  args: { scenario: 'stale' },
  play: async ({ canvasElement }) => {
    const canvas = await submitFields(canvasElement);
    await waitFor(() => expect(canvas.getAllByText(m.correction_stale())).toHaveLength(2));
  },
};
export const Invalid: Story = {
  args: { scenario: 'invalid' },
  play: async ({ canvasElement }) => {
    const canvas = await submitFields(canvasElement);
    await waitFor(() => expect(canvas.getAllByText(m.correction_invalid())).toHaveLength(2));
  },
};
export const UncertainRetry: Story = {
  args: { scenario: 'lost-response' },
  play: async ({ canvasElement }) => {
    const canvas = await submitFields(canvasElement);
    await waitFor(() => expect(canvas.getAllByText(m.facts_uncertain())).toHaveLength(2));
    await userEvent.click(canvas.getByRole('button', { name: m.facts_submit() }));
    await expect(canvas.findByText(m.facts_results({ count: 2 }))).resolves.toBeVisible();
  },
};

// Additive UNRUN examples. Existing scenarios above retain their original fixtures and play functions.
function IndependentExample() {
  return (
    <PatternStory visitor="Signed In">
      <AppShell>
        <section aria-label="First mounted workspace">
          <Workspace scenario="ready" />
        </section>
        <section aria-label="Second mounted workspace">
          <Workspace scenario="ready" />
        </section>
      </AppShell>
    </PatternStory>
  );
}

async function independentKeyboard(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const label = pickText(definitions.release.properties['schema:inLanguage'].labels, getLocale()).text;
  const firstWorkspace = within(await canvas.findByRole('region', { name: 'First mounted workspace' }));
  const secondWorkspace = within(canvas.getByRole('region', { name: 'Second mounted workspace' }));
  const firstRegion = await firstWorkspace.findByRole('region', { name: label });
  const secondRegion = await secondWorkspace.findByRole('region', { name: label });
  const first = within(firstRegion);
  const second = within(secondRegion);
  const firstSelect = first.getByRole('combobox', { name: m.facts_choose_value() });
  const secondSelect = second.getByRole('combobox', { name: m.facts_choose_value() });
  await expect(firstSelect.id).not.toBe(secondSelect.id);
  await userEvent.selectOptions(
    secondSelect,
    second.getByRole('option', { name: m.facts_selected_value({ number: 2 }) }),
  );
  await expect(first.getByRole('button', { name: m.facts_edit_field() })).toBeDisabled();
  await expect(firstSelect).toHaveValue('');
  await userEvent.selectOptions(
    firstSelect,
    first.getByRole('option', { name: m.facts_selected_value({ number: 1 }) }),
  );
  const firstEdit = first.getByRole('button', { name: m.facts_edit_field() });
  firstEdit.focus();
  await expect(firstEdit).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  await expect(second.queryByRole('checkbox', { name: m.facts_include() })).toBeNull();
  const secondEdit = second.getByRole('button', { name: m.facts_edit_field() });
  secondEdit.focus();
  await userEvent.keyboard('{Enter}');
  const firstInclude = first.getByRole('checkbox', { name: m.facts_include() });
  const secondInclude = second.getByRole('checkbox', { name: m.facts_include() });
  const includeInputs: HTMLInputElement[] = [];
  for (const [region, control] of [
    [firstRegion, firstInclude],
    [secondRegion, secondInclude],
  ]) {
    const input = control!.parentElement!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    includeInputs.push(input);
    const label = region!.querySelector<HTMLLabelElement>(`label[for="${input.id}"]`)!;
    await expect(label).toHaveTextContent(m.facts_include());
    await expect(canvasElement.ownerDocument.getElementById(label.htmlFor)).toBe(input);
    await expect(control).toHaveAccessibleName(m.facts_include());
  }
  await expect(includeInputs[0]!.id).not.toBe(includeInputs[1]!.id);
  await expect(first.getAllByRole('textbox', { name: m.correction_value() })[0]!).toHaveValue('en');
  await expect(second.getAllByRole('textbox', { name: m.correction_value() })[0]!).toHaveValue('fr');
  secondInclude.focus();
  await expect(secondInclude).toHaveFocus();
  await userEvent.keyboard('[Space]');
  await expect(secondInclude).not.toBeChecked();
  await expect(firstInclude).toBeChecked();
  const value = second.getAllByRole('textbox', { name: m.correction_value() })[0]!;
  await userEvent.clear(value);
  await userEvent.type(value, 'de');
  await expect(first.getAllByRole('textbox', { name: m.correction_value() })[0]!).toHaveValue('en');
  await expect(firstWorkspace.getByRole('button', { name: m.facts_submit() })).toBeDisabled();
  await expect(secondWorkspace.getByRole('button', { name: m.facts_submit() })).toBeDisabled();
  secondInclude.focus();
  await userEvent.keyboard('[Space]');
  await expect(secondWorkspace.getByRole('button', { name: m.facts_submit() })).toBeEnabled();
  await expect(firstWorkspace.getByRole('button', { name: m.facts_submit() })).toBeDisabled();
  return [firstRegion, secondRegion];
}

async function phoneTargets(regions: HTMLElement[]) {
  for (const region of regions) {
    const bounds = region.getBoundingClientRect();
    await expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth + 1);
    for (const control of region.querySelectorAll<HTMLElement>('button, select, a, [role="checkbox"]')) {
      // StatementFields owns its separate controls and acceptance; inspect this family's controls.
      const fieldset = control.closest('fieldset');
      if (fieldset && region.contains(fieldset)) continue;
      const rect = control.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      await expect(rect.height).toBeGreaterThanOrEqual(44);
      await expect(rect.width).toBeGreaterThanOrEqual(44);
      await expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 1);
      await expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
    }
  }
}

export const IndependentKeyboard: Story = {
  render: () => <IndependentExample />,
  play: async ({ canvasElement }) => {
    await independentKeyboard(canvasElement);
  },
};

export const IndependentPhone: Story = {
  render: () => <IndependentExample />,
  globals: { viewport: { value: 'phone390', isRotated: false } },
  parameters: {
    docs: {
      description: {
        story:
          'UNRUN: two actual workspaces, independent keyboard selection/inclusion and rendered 44px phone targets. Browser, native and visual acceptance remain deferred.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await phoneTargets(await independentKeyboard(canvasElement));
  },
};

const longFieldLabel =
  'Exact catalogue match for the complete original annotated edition, including its full bibliographic identity, original language and statement-level evidence';
const longSelectedValue =
  'https://catalogue.example/editions/' +
  'the-complete-original-annotated-edition-'.repeat(10) +
  '?record=A%2Fb&language=ja#original';
const longCitation =
  'https://archive.example/records/' + 'unabridged-source-catalogue-'.repeat(8) + '?scan=original%2Fpage-24#citation';
const chosenStatement = '00000000-0000-4000-8000-00000000d113';

function LongEvidenceWorkspace() {
  const locale = getLocale();
  const fixture = useMemo(() => identifiersProfileFixture('ready', locale), [locale]);
  const query = useQuery({
    queryKey: ['subject-facts-family-long', locale],
    retry: false,
    queryFn: async () => {
      const result = await fixture.transport.read();
      if (!result.ok) return result;
      // Explicit supplied-data variants, using the same installed reader and controls.
      const read = structuredClone(result);
      read.release.properties['schema:sameAs']!.labels = { [locale]: longFieldLabel };
      const first = read.public.subject.statements['schema:sameAs']![0]!;
      const second = structuredClone(first);
      second.id = chosenStatement;
      second.value = { type: 'value', content: longSelectedValue };
      second.qualifiers = [
        {
          property: { id: 'schema:name', data_type: 'monolingualtext' },
          value: { type: 'value', content: { text: 'Édition originale intégrale', language: 'fr' } },
        },
      ];
      second.references[0]!.parts[0]!.value = { type: 'value', content: longCitation };
      read.public.subject.statements['schema:sameAs']!.push(second);
      return read;
    },
  });
  if (!query.data)
    return (
      <p role="status" className="p-6">
        {m.candidate_loading()}
      </p>
    );
  return <SubjectFacts initial={query.data} locale={locale} transport={fixture.transport} review={fixture.review} />;
}

export const LongSelectedEvidencePhone: Story = {
  render: () => (
    <PatternStory visitor="Signed In">
      <AppShell>
        <LongEvidenceWorkspace />
      </AppShell>
    </PatternStory>
  ),
  globals: { viewport: { value: 'phone390', isRotated: false } },
  parameters: {
    docs: {
      description: {
        story:
          'UNRUN: full long labels, two ordered selected assertions, French qualifier and Japanese citation text. Current evidence remains immutable beside the explicit private draft. Geometry and focus assertions await browser execution.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const region = await canvas.findByRole('region', { name: longFieldLabel });
    const field = within(region);
    const current = field.getByRole('heading', { name: m.candidate_current() }).closest('section')!;
    const evidence = [...current.querySelectorAll(':scope > ol > li')];
    await expect(evidence).toHaveLength(2);
    await expect(evidence[0]!).toHaveTextContent(m.facts_selected_value({ number: 1 }));
    await expect(evidence[1]!).toHaveTextContent(m.facts_selected_value({ number: 2 }));
    await expect(evidence[1]!).toHaveTextContent(longSelectedValue);
    await expect(evidence[1]!.querySelector('[lang="fr"]')).toHaveTextContent('Édition originale intégrale');
    await expect(evidence[1]!.querySelector('[lang="ja"]')).toHaveTextContent('原本の書誌');
    await expect(
      [...evidence[1]!.querySelectorAll<HTMLAnchorElement>('a')].map((link) => link.getAttribute('href')),
    ).toEqual([longSelectedValue, longCitation]);
    await expect(evidence[0]!.querySelector('a')).toHaveAttribute('href', identifiersCitation);
    await phoneTargets([region]);
    const citation = within(evidence[1] as HTMLElement).getByRole('link', { name: longCitation });
    await userEvent.keyboard('{Tab}');
    citation.focus();
    await expect(citation).toHaveFocus();
    await waitFor(() => expect(getComputedStyle(citation).outlineStyle).not.toBe('none'));
    await userEvent.selectOptions(field.getByRole('combobox', { name: m.facts_choose_value() }), chosenStatement);
    await userEvent.click(field.getByRole('button', { name: m.facts_edit_field() }));
    const value = field.getAllByRole('textbox', { name: m.correction_value() })[0]!;
    await expect(value).toHaveValue(longSelectedValue);
    await userEvent.clear(value);
    await userEvent.type(value, 'https://catalogue.example/explicit-private-draft');
    await expect(current).toHaveTextContent(longSelectedValue);
    await expect(current).not.toHaveTextContent('https://catalogue.example/explicit-private-draft');
    await phoneTargets([region]);
  },
};
