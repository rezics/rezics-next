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
