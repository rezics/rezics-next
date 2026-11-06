import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useMemo, useRef, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { SubjectSourcesPage } from '../features/catalogue/subject-sources-page';
import { explainSubjectSources, readSubjectSources, type SourcesResult } from '../features/catalogue/subject-sources';
import {
  catalogueSourcesFixture,
  citationUrl,
  recordedSelectedSynopsisSelection,
  sourceDefinitions,
  type CatalogueSourcesExact,
  type SourcesScenario,
} from '../kernel/fake/catalogue-sources';
import { RECORDED_SELECTED_SYNOPSIS_CITATION } from '../kernel/recorded/selected-synopsis';
import { PatternStory } from './page';
import { AppShell } from '../shell/shell';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { useSourcesRetry } from '../features/catalogue/subject-sources-retry';
import { summaryReadingFragment } from '../features/pages/subject-visit-navigation';

let retryAbaNavigate: ((visit: 'a' | 'b') => Promise<void>) | undefined;
let retryAbaRelease: (() => void) | undefined;
let retryAbaHeld = false;

type SourcesStoryProps = {
  scenario?: SourcesScenario;
  loading?: boolean;
  exact?: CatalogueSourcesExact;
  retryAba?: boolean;
};

function SourcesStory(props: SourcesStoryProps) {
  return (
    <PatternStory path="/?retryVisit=a" visitor="Signed Out">
      <AppShell>
        <SourcesStoryPage {...props} />
      </AppShell>
    </PatternStory>
  );
}

function SourcesStoryPage({
  scenario = 'selected-facts',
  loading = false,
  exact,
  retryAba = false,
}: {
  scenario?: SourcesScenario;
  loading?: boolean;
  exact?: CatalogueSourcesExact;
  retryAba?: boolean;
}) {
  const router = useRouter();
  const locale = getLocale();
  const fixture = useMemo(
    () => catalogueSourcesFixture(scenario, exact ? { exact } : {}),
    [scenario, locale, exact],
  );
  const selection = exact
    ? { ...recordedSelectedSynopsisSelection, locale, context: fixture.read.subject.context }
    : undefined;
  const via = selection ? `/en/subjects/${fixture.id}/work${summaryReadingFragment(selection)}` : undefined;
  const initial: SourcesResult = ['denied', 'invalid', 'conflict', 'unavailable'].includes(scenario)
    ? { kind: scenario as 'denied' | 'invalid' | 'conflict' | 'unavailable' }
    : { kind: 'ready', page: explainSubjectSources(fixture.read, locale, sourceDefinitions) };
  const [result, setResult] = useState(initial);
  const releaseRetry = useRef<(() => void) | undefined>(undefined);
  const retry = useSourcesRetry({
    realm: undefined,
    reader: null,
    locale,
    loading,
    reset: async () => {
      if (retryAba) {
        await new Promise<void>((resolve) => {
          retryAbaHeld = true;
          releaseRetry.current = () => {
            retryAbaHeld = false;
            resolve();
          };
        });
      }
      fixture.recover();
      setResult(await readSubjectSources(fixture.client, fixture.id, locale, sourceDefinitions, false, via));
    },
  });
  retryAbaNavigate = retryAba
    ? async (visit) => {
        await router.navigate({ to: `/?retryVisit=${visit}` } as never);
      }
    : undefined;
  retryAbaRelease = retryAba ? () => releaseRetry.current?.() : undefined;
  return (
    <SubjectSourcesPage
      result={loading ? { kind: 'loading' } : result}
      locale={locale}
      busy={retry.busy}
      headingRef={retry.headingRef}
      onRetry={retry.onRetry}
      {...(via ? { returnTo: via } : {})}
    />
  );
}
const meta = {
  title: 'Pages/Subjects/Catalogue sources',
  id: 'pages-subject-selected-sources',
  component: SourcesStory,
  parameters: { layout: 'fullscreen' },
  render: (args) => (
    <SourcesStory key={`${getLocale()}:${args.scenario}:${args.loading}:${args.exact}:${args.retryAba}`} {...args} />
  ),
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
  args: { exact: 'matched' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(await canvas.findByRole('link', { name: RECORDED_SELECTED_SYNOPSIS_CITATION })).toBeTruthy();
    expect(canvas.queryByRole('link', { name: citationUrl })).toBeNull();
  },
};
export const ExactSynopsisEmptyCitations: Story = {
  args: { exact: 'matched-empty' },
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
    const retry = await canvas.findByRole('button', { name: m.sources_retry() });
    retry.focus();
    await userEvent.keyboard('{Enter}');
    const heading = await canvas.findByRole('heading', { name: m.subject_sources() });
    await waitFor(() => expect(canvasElement.ownerDocument.activeElement).toBe(heading));
  },
};
export const UnavailableRetryPhone: Story = { ...UnavailableRetry, globals: { viewport: { value: 'phone390' } } };
export const UnavailableRetryDesktop: Story = { ...UnavailableRetry, globals: { viewport: { value: 'desktop1280' } } };
async function retryAbaStory(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const retry = await canvas.findByRole('button', { name: m.sources_retry() });
  retry.focus();
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(retryAbaHeld).toBe(true));
  await retryAbaNavigate?.('b');
  await retryAbaNavigate?.('a');
  retryAbaRelease?.();
  await canvas.findByRole('link', { name: RECORDED_SELECTED_SYNOPSIS_CITATION });
  await waitFor(() => {
    const heading = canvas.getByRole('heading', { name: m.subject_sources() });
    expect(canvasElement.ownerDocument.activeElement).not.toBe(heading);
  });
}
export const UnavailableRetryABAPhone: Story = {
  args: { scenario: 'unavailable', exact: 'matched', retryAba: true },
  globals: { viewport: { value: 'phone390' } },
  play: async ({ canvasElement }) => retryAbaStory(canvasElement),
};
export const UnavailableRetryABADesktop: Story = {
  args: { scenario: 'unavailable', exact: 'matched', retryAba: true },
  globals: { viewport: { value: 'desktop1280' } },
  play: async ({ canvasElement }) => retryAbaStory(canvasElement),
};

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
