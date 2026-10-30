import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useMemo, useState } from 'react';
import { SubjectSourcesPage } from '../features/catalogue/subject-sources-page';
import { explainSubjectSources, readSubjectSources, type SourcesResult } from '../features/catalogue/subject-sources';
import { catalogueSourcesFixture, citationUrl, sourceDefinitions, type SourcesScenario } from '../kernel/fake/catalogue-sources';
import { PatternStory } from './page';
import { AppShell } from '../shell/shell';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';

function SourcesStory({ scenario = 'selected-facts', loading = false }: { scenario?: SourcesScenario; loading?: boolean }) {
  const locale = getLocale();
  const fixture = useMemo(() => catalogueSourcesFixture(scenario), [scenario, locale]);
  const initial: SourcesResult = ['denied', 'invalid', 'conflict', 'unavailable'].includes(scenario)
    ? { kind: scenario as 'denied' | 'invalid' | 'conflict' | 'unavailable' }
    : { kind: 'ready', page: explainSubjectSources(fixture.read, locale, sourceDefinitions) };
  const [result, setResult] = useState(initial);
  const [busy, setBusy] = useState(false);
  return (
    <PatternStory path="/" visitor="Signed Out">
      <AppShell>
        <SubjectSourcesPage result={loading ? { kind: 'loading' } : result} locale={locale} busy={busy} onRetry={async () => {
          setBusy(true);
          fixture.recover();
          setResult(await readSubjectSources(fixture.client, fixture.id, locale, sourceDefinitions));
          setBusy(false);
        }} />
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Subject/Sources', component: SourcesStory,
  parameters: { layout: 'fullscreen' },
  render: (args) => <SourcesStory key={`${getLocale()}:${args.scenario}:${args.loading}`} {...args} />,
} satisfies Meta<typeof SourcesStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SelectedFacts: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(await canvas.findByRole('article'));
    const citations = page.getAllByRole('link', { name: citationUrl });
    expect(citations[0]?.getAttribute('href')).toBe(citationUrl);
    expect(page.getAllByRole('link', { name: m.sources_compare() })[0]?.getAttribute('href')).toContain('candidateField=');
    await userEvent.tab();
    expect(page.getByRole('link', { name: m.sources_back() }).getAttribute('href')).toContain(fixtureId());
  },
};
function fixtureId() { return catalogueSourcesFixture().id; }
export const NoCitations: Story = { args: { scenario: 'no-citations' } };
export const PartialMetadata: Story = { args: { scenario: 'partial-metadata' } };
export const Empty: Story = { args: { scenario: 'empty' } };
export const Loading: Story = { args: { loading: true } };
export const Denied: Story = { args: { scenario: 'denied' } };
export const Invalid: Story = { args: { scenario: 'invalid' } };
export const Conflict: Story = { args: { scenario: 'conflict' } };
export const UnavailableRetry: Story = {
  args: { scenario: 'unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.sources_retry() }));
    expect(await canvas.findByRole('heading', { name: m.sources_selected() })).toBeTruthy();
  },
};
