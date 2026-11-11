import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useState, type ComponentProps } from 'react';
import { SubjectSourcesPage } from '../features/catalogue/subject-sources-page';
import { explainSubjectSources, readSubjectSources, type SourcesPageData } from '../features/catalogue/subject-sources';
import {
  catalogueSourcesFixture,
  citationUrl,
  sourceDefinitions,
  type SourcesScenario,
} from '../kernel/fake/catalogue-sources';
import { subjectSourcesPage } from '../kernel/fake/subject-sources';
import { subjectBody, type SubjectPageData } from '../features/pages/subject';
import { AppShell } from '../shell/shell';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';

const arabic = 'المؤلف ومعلومات الطبعة الأصلية والمراجع المرتبطة بالرحلة الطويلة عبر المكتبات والأرشيفات';
const japanese = '旅人の物語 — 長い道のりを越えて、ふたたび出会う人々と終わらない読書の記録';
const archive = 'https://archive.example.test/catalogue/second-citation-with-a-long-original-record-address';
const edition = 'https://catalogue.example.test/editions/original';

/** Finite supplied presentation data extending the canonical selected-facts recording, without a new reader. */
function richPage(page: SourcesPageData): SourcesPageData {
  const target = '00000000-0000-8000-8000-000000000042';
  const urlPart = (text: string, url: string) => ({
    label: { text, lang: 'fr' },
    snak: { property: { id: 'schema:url', data_type: 'url' }, value: { type: 'value', content: url } },
  });
  return {
    ...page,
    related: { ...page.related, [target]: { labels: { ja: japanese } } },
    fields: [
      ...page.fields,
      {
        property: 'schema:author',
        label: { text: arabic, lang: 'ar' },
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
                  value: {
                    type: 'value',
                    content: {
                      text: 'Édition originale conservée et vérifiée par les bibliothécaires',
                      language: 'fr',
                    },
                  },
                },
              },
              urlPart('Notice de l’édition originale', edition),
            ],
            citations: [
              [urlPart('Catalogue', citationUrl)],
              [urlPart('Archive', archive)],
              [urlPart('Catalogue', citationUrl)],
            ],
          },
          {
            snak: {
              property: { id: 'schema:name', data_type: 'monolingualtext' },
              value: { type: 'value', content: { text: arabic, language: 'ar' } },
            },
            qualifiers: [],
            citations: [],
          },
          ...(['somevalue', 'novalue'] as const).map((type) => ({
            snak: { property: { id: 'schema:name', data_type: 'monolingualtext' }, value: { type } },
            qualifiers: [],
            citations: [],
          })),
          ...(['document', 'media'] as const).map((display) => ({
            snak: {
              property: { id: display === 'document' ? 'schema:abstract' : 'schema:image', data_type: display },
              value: { type: 'somevalue' },
            },
            display,
            qualifiers: [],
            citations: [],
          })),
        ],
      },
      {
        property: 'schema:alternateName',
        label: { text: '', lang: undefined },
        facts: [
          {
            snak: {
              property: { id: 'schema:alternateName', data_type: 'monolingualtext' },
              value: { type: 'somevalue' },
            },
            qualifiers: [],
            citations: [],
          },
        ],
      },
    ],
    // Repeated recorded support remains repeated, including independent licence links and cover credit.
    sources: { ...page.sources, records: [...page.sources.records, ...page.sources.records] },
  };
}

type Scenario = SourcesScenario | 'loading' | 'missing';
type Result = ComponentProps<typeof SubjectSourcesPage>['result'];

function Reader({
  scenario,
  rich,
  allRecords,
  coverUnknown,
}: {
  scenario: Scenario;
  rich: boolean;
  allRecords: boolean;
  coverUnknown: boolean;
}) {
  const locale = getLocale();
  const [fixture] = useState(() =>
    catalogueSourcesFixture(scenario === 'loading' || scenario === 'missing' ? 'selected-facts' : scenario),
  );
  const [result, setResult] = useState<Result>(() => {
    if (
      scenario === 'loading' ||
      scenario === 'missing' ||
      scenario === 'denied' ||
      scenario === 'invalid' ||
      scenario === 'conflict' ||
      scenario === 'unavailable'
    )
      return { kind: scenario };
    const page = explainSubjectSources(fixture.read, locale, sourceDefinitions);
    if (allRecords) {
      const recorded = subjectSourcesPage({ target: { subject: fixture.id } });
      const read = recorded && subjectBody(recorded as unknown as SubjectPageData);
      if (!read) throw new Error('Expected the canonical all-source-records story selection');
      page.sources = explainSubjectSources(read, locale, sourceDefinitions).sources;
    }
    if (coverUnknown) page.sources = { ...page.sources, credit: null };
    return { kind: 'ready', page: rich ? richPage(page) : page };
  });
  const [busy, setBusy] = useState(false);
  return (
    <SubjectSourcesPage
      result={result}
      locale={locale}
      busy={busy}
      onRetry={async () => {
        setBusy(true);
        fixture.recover();
        setResult(await readSubjectSources(fixture.client, fixture.id, locale, sourceDefinitions));
        setBusy(false);
      }}
    />
  );
}

function DetailJourney({
  scenario = 'selected-facts',
  allRecords = false,
  coverUnknown = false,
}: {
  scenario?: Scenario;
  allRecords?: boolean;
  coverUnknown?: boolean;
}) {
  return (
    <PatternStory path={allRecords ? '/?sourceRecords=all' : '/'} visitor="Signed Out">
      <AppShell>
        <div className="min-w-0 space-y-12">
          <div dir="rtl" data-reader="first">
            <Reader
              key={`${getLocale()}:${scenario}:${allRecords}:${coverUnknown}:first`}
              scenario={scenario}
              rich={scenario === 'selected-facts'}
              allRecords={allRecords}
              coverUnknown={coverUnknown}
            />
          </div>
          <div data-reader="second">
            <Reader
              key={`${getLocale()}:${scenario}:${allRecords}:${coverUnknown}:second`}
              scenario={scenario}
              rich={false}
              allRecords={allRecords}
              coverUnknown={coverUnknown}
            />
          </div>
        </div>
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Subjects/Detailed sources family',
  id: 'pages-subjects-detailed-sources-family',
  component: DetailJourney,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'UNRUN: actual detailed readers using canonical recorded fixtures, at phone 390 and desktop 1280 in both themes and all launch locales. Supplied rich text/RTL, repeated citations and support retain their full order. O(supplied rows/text), constant presentation overhead per group, zero rendering IO or population/history traversal. Native, physical growth, browser geometry and original acceptance remain deferred.',
      },
    },
  },
} satisfies Meta<typeof DetailJourney>;
export default meta;
type Story = StoryObj<typeof meta>;

export const IndependentReaders: Story = {
  play: async ({ canvasElement }) => {
    const readers = [...canvasElement.querySelectorAll<HTMLElement>('[data-slot="subject-sources-detail"]')];
    expect(readers).toHaveLength(2);
    const ids: string[] = [];
    for (const reader of readers) {
      const selected = within(reader).getByRole('heading', { level: 2, name: m.sources_selected() });
      expect(selected.closest('section')).toHaveAttribute('aria-labelledby', selected.id);
      const groups = [...reader.querySelectorAll<HTMLElement>('[data-slot="source-property"]')];
      for (const group of groups) {
        const heading = group.querySelector('h3')!;
        expect(group.closest('section')).toHaveAttribute('aria-labelledby', heading.id);
        ids.push(heading.id);
      }
      ids.push(selected.id);
    }
    expect(new Set(ids).size).toBe(ids.length);
    const first = readers[0]!;
    const value = within(first).getByRole('heading', { level: 4, name: japanese });
    const row = value.closest('[data-slot="source-statement"]') as HTMLElement;
    expect(within(first).getByRole('heading', { level: 3, name: arabic })).toHaveAttribute('lang', 'ar');
    expect(row.querySelectorAll('ol > li')).toHaveLength(3);
    expect(row.querySelector('a a, a button')).toBeNull();
    const links = within(row).getAllByRole('link');
    links[0]!.focus();
    for (const [index, link] of links.entries()) {
      await expect(link).toHaveFocus();
      const bounds = link.getBoundingClientRect();
      expect(bounds.width).toBeGreaterThanOrEqual(44);
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      if (index < links.length - 1) await userEvent.tab();
    }
    expect(first.scrollWidth).toBeLessThanOrEqual(first.clientWidth + 1);
    expect(within(first).getByText(m.sources_rights_scope())).toBeVisible();
    expect(within(first).getAllByRole('link', { name: 'CC0-1.0' })).toHaveLength(2);
    expect(within(first).getByRole('link', { name: 'Generated fixture' })).toHaveAttribute(
      'href',
      'https://rezics.com',
    );
  },
};

export const NoCitations: Story = { args: { scenario: 'no-citations' } };
export const PartialMetadata: Story = { args: { scenario: 'partial-metadata' } };
export const UnknownCoverRights: Story = { args: { scenario: 'partial-metadata', coverUnknown: true } };
export const AllRecordedAttribution: Story = {
  args: { allRecords: true },
  play: async ({ canvasElement }) => {
    const reader = within(canvasElement.querySelector<HTMLElement>('[data-reader="second"]')!);
    const sources = within(reader.getByRole('region', { name: m.sources_metadata() }));
    expect(sources.getByRole('link', { name: 'CC-BY-4.0' })).toHaveAttribute(
      'href',
      'https://creativecommons.org/licenses/by/4.0/',
    );
    expect(sources.getByText('ODbL-1.0', { exact: true })).toBeVisible();
    expect(sources.getByText('The Museum Research Team')).toBeVisible();
    expect(sources.getByRole('link', { name: 'Generated fixture' })).toHaveAttribute('href', 'https://rezics.com');
  },
};
export const Empty: Story = { args: { scenario: 'empty' } };
export const Loading: Story = { args: { scenario: 'loading' } };
export const Missing: Story = { args: { scenario: 'missing' } };
export const Denied: Story = { args: { scenario: 'denied' } };
export const Invalid: Story = { args: { scenario: 'invalid' } };
export const Conflict: Story = { args: { scenario: 'conflict' } };
export const IndependentRetries: Story = {
  args: { scenario: 'unavailable' },
  play: async ({ canvasElement }) => {
    const first = within(canvasElement.querySelector<HTMLElement>('[data-reader="first"]')!);
    const second = within(canvasElement.querySelector<HTMLElement>('[data-reader="second"]')!);
    await userEvent.click(first.getByRole('button', { name: m.sources_retry() }));
    expect(await first.findByRole('heading', { name: m.sources_selected() })).toBeVisible();
    expect(second.getByRole('alert')).toHaveTextContent(m.sources_unavailable());
    await userEvent.click(second.getByRole('button', { name: m.sources_retry() }));
    expect(await second.findByRole('heading', { name: m.sources_selected() })).toBeVisible();
  },
};
