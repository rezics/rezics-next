import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useMemo } from 'react';
import { ValueExplanation } from '../features/catalogue/value-explanation-page';
import type { ValueTransport } from '../features/catalogue/value-explanation';
import { valueExplanationFixture, type ValueScenario } from '../kernel/fake/value-explanation';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';

function WhyStory({ scenario = 'selected' }: { scenario?: ValueScenario }) {
  const locale = getLocale();
  const fixture = useMemo(() => valueExplanationFixture(scenario, locale), [scenario, locale]);
  return (
    <PatternStory visitor="Signed In" path="/">
      <AppShell>
        <ValueExplanation key={`${scenario}:${locale}`} locale={locale} transport={fixture.transport} />
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Catalogue/Why this value',
  component: WhyStory,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof WhyStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Selected: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('9780156012195')).toBeVisible();
    await expect(canvas.getByText('Édition originale')).toHaveAttribute('lang', 'fr');
    await expect(canvas.getByRole('link', { name: m.subject_sources() })).toHaveAttribute(
      'href',
      expect.stringContaining('/sources'),
    );
    await expect(canvas.getByText(m.value_change_unavailable())).toBeVisible();
  },
};
export const ContinueReview: Story = {
  args: { scenario: 'paged' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(m.value_not_returned())).toBeVisible();
    await userEvent.click(await canvas.findByRole('button', { name: m.value_more() }));
    await waitFor(() => expect(canvas.getByRole('button', { name: m.value_more() })).toBeEnabled());
    await userEvent.click(canvas.getByRole('button', { name: m.value_more() }));
    await expect(await canvas.findByText(m.value_accepted())).toBeVisible();
    await expect(canvas.getByText('9780156012195')).toBeVisible();
    await expect(canvas.queryByText('UNSELECTED PRIVATE ALTERNATIVE')).toBeNull();
  },
};
export const ReviewDenied: Story = { args: { scenario: 'review-denied' } };
export const ReviewUnavailable: Story = { args: { scenario: 'review-error' } };
export const Unresolved: Story = { args: { scenario: 'unresolved' } };
export const NoLongerSelected: Story = { args: { scenario: 'not-selected' } };
export const UnknownValue: Story = { args: { scenario: 'somevalue' } };
export const NoValue: Story = { args: { scenario: 'novalue' } };
export const Concealed: Story = { args: { scenario: 'concealed' } };
export const ReadError: Story = { args: { scenario: 'error' } };
export const Loading: Story = { args: { scenario: 'loading' } };
export const DocumentUnavailable: Story = { args: { scenario: 'document' } };

export const DecisionNotIncluded: Story = {
  args: { scenario: 'paged' },
  parameters: {
    docs: {
      description: {
        story:
          'UNRUN: the real paged consumer fixture omits the selected candidate, then returns an empty page with another Next. No native or visual acceptance is claimed.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(m.value_page_bound())).toBeVisible();
    await expect(canvas.getByText('9780156012195')).toBeVisible();
    expect(canvas.queryByText(m.candidate_rejected_state())).toBeNull();
    const next = await canvas.findByRole('button', { name: m.value_more() });
    await userEvent.click(next);
    await expect(await canvas.findByText(m.value_page_bound())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.value_more() })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: m.value_restart() })).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: m.value_more() }));
    await expect(await canvas.findByText(m.value_accepted())).toBeVisible();
    expect(canvas.queryByText(m.value_page_bound())).toBeNull();
    expect(canvas.queryByRole('button', { name: m.value_more() })).toBeNull();
    const technical = canvas.getByText(m.catalogue_technical_details()).closest('details')!;
    expect(technical.open).toBe(false);
    expect(within(technical).getByText(m.value_basis())).toBeTruthy();
  },
};

const longEvidenceTitle = '旅人の物語 — 読み継がれる長い名前と記録 '.repeat(6);
const longEvidenceValue = '選ばれた値 Édition originale العربية 한국어 '.repeat(8) + 'LongUnbrokenValue'.repeat(24);
const longEvidenceReference = '出典の全文 Référence complète العربية '.repeat(12);
const longEvidenceUrl = `https://catalogue.example.test/${'long-reference'.repeat(25)}?source=exact%2Bvalue#original`;
const evidenceLabels = ['選ばれた書誌の値 — 第一の説明', '別の書誌の値 — 第二の説明'] as const;

/** Additive contract-shaped supplied readings; the canonical fixtures and their request paths stay intact. */
function EvidenceFamilyStory({ single = false }: { single?: boolean }) {
  const locale = getLocale();
  const transports = useMemo(
    () =>
      evidenceLabels.map((label): ValueTransport => {
        const fixture = valueExplanationFixture('paged', locale);
        return async (cursor, session) => {
          const result = await fixture.transport(cursor, session);
          if (result.kind !== 'ready' || !result.page.statement) return result;
          return {
            ...result,
            page: {
              ...result.page,
              title: { text: longEvidenceTitle, lang: 'ja' },
              typeLabel: { text: '書籍とその書誌情報', lang: 'ja' },
              propertyLabel: { text: label, lang: 'ja' },
              labels: { ...result.page.labels, 'example:reference': { text: '出典の説明', lang: 'ja' } },
              statement: {
                ...result.page.statement,
                property: { ...result.page.statement.property, data_type: 'monolingualtext' },
                value: { type: 'value', content: { text: longEvidenceValue, language: 'ja' } },
                qualifiers: [
                  ...result.page.statement.qualifiers,
                  {
                    property: { id: 'example:qualifier', data_type: 'string' },
                    value: { type: 'value', content: '補足された意味と原文のままの条件 '.repeat(12) },
                  },
                ],
                references: [
                  ...result.page.statement.references,
                  {
                    hash: 'fixture-only-long-reference',
                    parts: [
                      {
                        property: { id: 'example:reference', data_type: 'monolingualtext' },
                        value: { type: 'value', content: { text: longEvidenceReference, language: 'fr' } },
                      },
                      {
                        property: { id: 'schema:url', data_type: 'url' },
                        value: { type: 'value', content: longEvidenceUrl },
                      },
                      {
                        property: { id: 'schema:url', data_type: 'url' },
                        value: { type: 'value', content: 'javascript:literal-unlinked-reference' },
                      },
                    ],
                  },
                  { hash: 'fixture-only-empty-reference', parts: [] },
                ],
              },
            },
          };
        };
      }),
    [locale],
  );
  return (
    <PatternStory visitor="Signed In" path="/">
      <AppShell>
        <div className="grid min-w-0 grid-cols-1 gap-10 p-4 xl:grid-cols-2">
          {transports.slice(0, single ? 1 : 2).map((transport, index) => (
            <ValueExplanation key={`${index}:${locale}`} locale={locale} transport={transport} />
          ))}
        </div>
      </AppShell>
    </PatternStory>
  );
}

export const IndependentEvidence: Story = {
  render: () => <EvidenceFamilyStory />,
  parameters: {
    docs: {
      description: {
        story:
          'Authored UNRUN: two actual explanations with distinct supplied labels, independent disclosure/focus/continuation, and full multilingual evidence. Review at 390 and 1280, both themes and supported locales. No native, physical phone, or visual acceptance is claimed.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 2, name: evidenceLabels[0] });
    await canvas.findByRole('heading', { level: 2, name: evidenceLabels[1] });
    const articles = [...canvasElement.querySelectorAll<HTMLElement>('article[data-slot="value-explanation"]')];
    expect(articles).toHaveLength(2);
    const ids = articles.flatMap((article) => [...article.querySelectorAll('h2')].map((heading) => heading.id));
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
    for (const article of articles) {
      const own = within(article);
      for (const heading of article.querySelectorAll('h2')) {
        const section = heading.closest('section')!;
        expect(section.getAttribute('aria-labelledby')).toBe(heading.id);
        expect(article.ownerDocument.getElementById(heading.id)).toBe(heading);
      }
      await expect(own.getByText(longEvidenceValue)).toBeVisible();
      await expect(own.getByText(longEvidenceReference.trim())).toBeVisible();
      await expect(own.getByRole('link', { name: longEvidenceUrl })).toHaveAttribute('href', longEvidenceUrl);
      expect(article.querySelector('a[href^="javascript:"]')).toBeNull();
      expect(article.querySelector('a a, a button, a summary')).toBeNull();
      const technical = article.querySelector<HTMLDetailsElement>('details')!;
      expect(technical.open).toBe(false);
      // Browser geometry witnesses are authored for the actual consumer; they have not been run.
      for (const node of article.querySelectorAll<HTMLElement>(
        'h2, [data-content-item-slot="preview"], ol > li, a, button, summary',
      )) {
        const style = getComputedStyle(node);
        expect(style.textOverflow).not.toBe('ellipsis');
        expect(['hidden', 'clip']).not.toContain(style.overflowY);
        expect(node.scrollWidth).toBeLessThanOrEqual(node.clientWidth + 1);
      }
      for (const control of article.querySelectorAll<HTMLElement>('a, button, summary')) {
        expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
        control.focus();
        await expect(control).toHaveFocus();
      }
      expect(article.ownerDocument.documentElement.scrollWidth).toBeLessThanOrEqual(
        article.ownerDocument.documentElement.clientWidth,
      );
    }
    const first = within(articles[0]!);
    const second = within(articles[1]!);
    const firstDetails = articles[0]!.querySelector<HTMLDetailsElement>('details')!;
    firstDetails.querySelector('summary')!.focus();
    await userEvent.keyboard('{Enter}');
    expect(firstDetails.open).toBe(true);
    expect(articles[1]!.querySelector<HTMLDetailsElement>('details')!.open).toBe(false);
    await userEvent.click(first.getByRole('button', { name: m.value_more() }));
    await waitFor(() => expect(first.getByRole('button', { name: m.value_more() })).toBeEnabled());
    await expect(second.getByText(m.value_page_bound())).toBeVisible();
    await userEvent.click(first.getByRole('button', { name: m.value_more() }));
    await expect(await first.findByText(m.value_accepted())).toBeVisible();
    expect(first.queryByRole('button', { name: m.value_more() })).toBeNull();
    await expect(second.getByRole('button', { name: m.value_more() })).toBeEnabled();
    await userEvent.click(second.getByRole('button', { name: m.candidate_reload() }));
    await expect(await second.findByText(m.value_page_bound())).toBeVisible();
    await expect(first.getByText(m.value_accepted())).toBeVisible();
    for (const bytes of ['UNSELECTED PRIVATE ALTERNATIVE', 'PRIVATE SOURCE', 'PRIVATE RECORD']) {
      expect(canvasElement.innerHTML).not.toContain(bytes);
    }
  },
};

export const LongEvidence: Story = {
  render: () => <EvidenceFamilyStory single />,
  parameters: {
    docs: {
      description: {
        story:
          'Authored UNRUN: full long supplied title, value, qualifiers, ordered source parts, safe exact URL and empty reference. Inspect at 390 and 1280 in both themes. DOM or authored geometry assertions are not real phone proof.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(longEvidenceValue)).toBeVisible();
    await expect(canvas.getByText(longEvidenceTitle.trim())).toHaveAttribute('lang', 'ja');
    for (const node of [canvas.getByText(longEvidenceReference.trim()), canvas.getByText('Édition originale')]) {
      if (getLocale() === 'fr') await expect(node).not.toHaveAttribute('lang');
      else await expect(node).toHaveAttribute('lang', 'fr');
    }
    await expect(canvas.getByRole('link', { name: longEvidenceUrl })).toHaveAttribute('href', longEvidenceUrl);
    const article = canvasElement.querySelector<HTMLElement>('article[data-slot="value-explanation"]')!;
    expect(canvas.getByText(longEvidenceTitle.trim()).textContent).toBe(longEvidenceTitle);
    expect(canvas.getByText(longEvidenceValue).textContent).toBe(longEvidenceValue);
    expect(canvas.getByText(longEvidenceReference.trim()).textContent).toBe(longEvidenceReference);
    expect(article.querySelector('[class*="line-clamp"], [class*="truncate"], [class*="overflow-hidden"]')).toBeNull();
    expect(article.ownerDocument.documentElement.scrollWidth).toBeLessThanOrEqual(
      article.ownerDocument.documentElement.clientWidth,
    );
  },
};
