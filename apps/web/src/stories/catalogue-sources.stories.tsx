import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useMemo, useState } from 'react';
import { SubjectSourcesPage } from '../features/catalogue/subject-sources-page';
import { explainSubjectSources, readSubjectSources, type SourcesResult } from '../features/catalogue/subject-sources';
import {
  catalogueSourcesFixture,
  citationUrl,
  sourceDefinitions,
  type SourcesScenario,
} from '../kernel/fake/catalogue-sources';
import { PatternStory } from './page';
import { AppShell } from '../shell/shell';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';

function SourcesStory({
  scenario = 'selected-facts',
  loading = false,
  exact,
}: {
  scenario?: SourcesScenario;
  loading?: boolean;
  exact?: 'distinct' | 'empty' | 'changed';
}) {
  const locale = getLocale();
  const fixture = useMemo(() => {
    const fixture = catalogueSourcesFixture(scenario);
    if (exact) {
      const { rezics: _revision, ...recorded } = fixture.read.subject.statements['schema:isbn']![0]!;
      fixture.read.selectedSynopsis =
        exact === 'changed'
          ? { kind: 'changed' }
          : {
              kind: 'matched',
              context: fixture.read.subject.context,
              release: fixture.read.subject.release,
              fact: {
                ...recorded,
                property: { id: 'schema:abstract', data_type: 'document' },
                value: { type: 'somevalue' },
                references:
                  exact === 'empty'
                    ? []
                    : [
                        {
                          hash: 'selected-reference',
                          parts: [
                            {
                              property: { id: 'schema:url', data_type: 'url' },
                              value: { type: 'value', content: 'https://catalogue.example.test/second-synopsis' },
                            },
                          ],
                        },
                      ],
              },
            };
    }
    return fixture;
  }, [scenario, locale, exact]);
  const initial: SourcesResult = ['denied', 'invalid', 'conflict', 'unavailable'].includes(scenario)
    ? { kind: scenario as 'denied' | 'invalid' | 'conflict' | 'unavailable' }
    : { kind: 'ready', page: explainSubjectSources(fixture.read, locale, sourceDefinitions) };
  const [result, setResult] = useState(initial);
  const [busy, setBusy] = useState(false);
  return (
    <PatternStory path="/" visitor="Signed Out">
      <AppShell>
        <SubjectSourcesPage
          result={loading ? { kind: 'loading' } : result}
          locale={locale}
          busy={busy}
          onRetry={async () => {
            setBusy(true);
            fixture.recover();
            setResult(await readSubjectSources(fixture.client, fixture.id, locale, sourceDefinitions));
            setBusy(false);
          }}
        />
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Subjects/Catalogue sources',
  id: 'pages-subject-selected-sources',
  component: SourcesStory,
  parameters: { layout: 'fullscreen' },
  render: (args) => <SourcesStory key={`${getLocale()}:${args.scenario}:${args.loading}:${args.exact}`} {...args} />,
} satisfies Meta<typeof SourcesStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SelectedFacts: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(await canvas.findByRole('article'));
    const citations = page.getAllByRole('link', { name: citationUrl });
    expect(citations[0]?.getAttribute('href')).toBe(citationUrl);
    expect(page.getAllByRole('link', { name: m.sources_compare() })[0]?.getAttribute('href')).toContain(
      'candidateField=',
    );
    await userEvent.tab();
    expect(page.getByRole('link', { name: m.sources_back() }).getAttribute('href')).toContain(fixtureId());
  },
};
function fixtureId() {
  return catalogueSourcesFixture().id;
}
export const NoCitations: Story = { args: { scenario: 'no-citations' } };
export const ExactSynopsisCitations: Story = {
  args: { exact: 'distinct' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(await canvas.findByRole('link', { name: 'https://catalogue.example.test/second-synopsis' })).toBeTruthy();
    expect(canvas.queryByRole('link', { name: citationUrl })).toBeNull();
  },
};
export const ExactSynopsisEmptyCitations: Story = {
  args: { exact: 'empty' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(await canvas.findByText(m.sources_no_citations())).toBeTruthy();
    expect(canvas.queryByRole('link', { name: citationUrl })).toBeNull();
  },
};
export const ExactSynopsisChanged: Story = { args: { exact: 'changed' } };
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
export const UnavailableRetryPhone: Story = { ...UnavailableRetry, globals: { viewport: { value: 'phone390' } } };
export const UnavailableRetryDesktop: Story = { ...UnavailableRetry, globals: { viewport: { value: 'desktop1280' } } };

const richTitle = '旅人の物語 — 長い道のりを越えて、ふたたび出会う人々と終わらない読書の記録';
const qualifierUrl = 'https://catalogue.example.test/editions/original';
const archiveUrl = 'https://archive.example.test/catalogue/second-citation-with-a-long-original-record-address';

/** Finite supplied presentation examples; no native transport fixture is changed. */
function RichStatementsStory() {
  const locale = getLocale();
  const fixture = catalogueSourcesFixture();
  const page = explainSubjectSources(fixture.read, locale, sourceDefinitions);
  const target = '00000000-0000-8000-8000-000000000042';
  page.related[target] = { labels: { ja: richTitle } };
  page.fields.push({
    property: 'schema:author',
    label: { text: 'المؤلف ومعلومات الطبعة الأصلية والمراجع المرتبطة', lang: 'ar' },
    facts: [
      {
        snak: {
          property: { id: 'schema:author', data_type: 'wikibase-item' },
          value: { type: 'value', content: target },
        },
        qualifiers: [
          {
            label: { text: 'Édition', lang: 'fr' },
            snak: {
              property: { id: 'schema:name', data_type: 'monolingualtext' },
              value: { type: 'value', content: { text: 'Édition originale', language: 'fr' } },
            },
          },
          {
            label: { text: 'Edition record', lang: 'en' },
            snak: { property: { id: 'schema:url', data_type: 'url' }, value: { type: 'value', content: qualifierUrl } },
          },
        ],
        citations: [
          [
            {
              label: { text: 'Catalogue', lang: 'en' },
              snak: {
                property: { id: 'schema:url', data_type: 'url' },
                value: { type: 'value', content: citationUrl },
              },
            },
          ],
          [
            {
              label: { text: 'Archive', lang: 'en' },
              snak: { property: { id: 'schema:url', data_type: 'url' }, value: { type: 'value', content: archiveUrl } },
            },
          ],
        ],
      },
    ],
  });
  return (
    <PatternStory path="/" visitor="Signed Out">
      <AppShell>
        <div dir="rtl" style={{ width: 320, maxWidth: '100%' }}>
          <SubjectSourcesPage result={{ kind: 'ready', page }} locale={locale} />
        </div>
      </AppShell>
    </PatternStory>
  );
}

export const RichStatements: Story = {
  render: () => <RichStatementsStory />,
  parameters: {
    docs: {
      description: {
        story:
          'UNRUN: supplied rich statement, qualifiers and ordered independent citations in a 320px RTL reading. Keyboard, target geometry, browser, visual and native proof are deferred.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const value = canvas.getByRole('heading', { level: 4, name: richTitle });
    const row = value.closest('[data-slot="source-statement"]') as HTMLElement;
    expect(within(value).getByRole('link', { name: richTitle }).getAttribute('lang')).toBe(
      getLocale() === 'ja' ? null : 'ja',
    );
    expect(within(row).getByText('Édition originale')).toHaveAttribute('lang', 'fr');
    const citations = within(row).getAllByRole('listitem');
    expect(citations).toHaveLength(2);
    expect(within(citations[0]!).getByRole('link').getAttribute('href')).toBe(citationUrl);
    expect(within(citations[1]!).getByRole('link').getAttribute('href')).toBe(archiveUrl);
    expect(row.querySelector('a a, a button, [data-slot="list-row-link"]')).toBeNull();
    const links = within(row).getAllByRole('link');
    links[0]!.focus();
    for (let index = 0; index < links.length; index++) {
      const link = links[index]!;
      await expect(link).toHaveFocus();
      const bounds = link.getBoundingClientRect();
      expect(bounds.width).toBeGreaterThanOrEqual(44);
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      expect(bounds.left).toBeGreaterThanOrEqual(row.getBoundingClientRect().left - 1);
      expect(bounds.right).toBeLessThanOrEqual(row.getBoundingClientRect().right + 1);
      if (index < links.length - 1) await userEvent.tab();
    }
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
    await expect(canvas.getByText(m.sources_rights_scope())).toBeVisible();
  },
};
