import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { pickText } from '@rezics/composition';
import { bundledRelease } from '@rezics/definitions/bundled';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import { WorkPartsPage } from '../features/catalogue/work-parts-page';
import { workPartsFixture, type WorkPartsScenario } from '../kernel/fake/work-parts';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';

const longPartTitle = '旅人の物語 第二巻 — 長い道のりを越えて、ふたたび出会う人々と終わらない読書の記録';
type PartsScenario = WorkPartsScenario | 'loading' | 'long-multilingual' | 'unresolved';

function WorkPartsExample({ scenario }: { scenario: PartsScenario }) {
  const locale = getLocale();
  const fixture = useMemo(
    () =>
      workPartsFixture(
        scenario === 'loading' || scenario === 'long-multilingual' || scenario === 'unresolved' ? 'current' : scenario,
        locale,
      ),
    [scenario, locale],
  );
  const initial = useMemo(() => {
    const supplied = fixture.snapshot();
    if (supplied.ok && (scenario === 'long-multilingual' || scenario === 'unresolved')) {
      return {
        ...supplied,
        rows: supplied.rows.map((row) => ({
          ...row,
          summary:
            scenario === 'unresolved' || !row.summary
              ? null
              : {
                  ...row.summary,
                  label: { value: longPartTitle, language: 'ja' },
                },
        })),
      };
    }
    return supplied;
  }, [fixture, scenario]);
  return (
    <PatternStory visitor="Signed In">
      <AppShell>
        <WorkPartsPage
          key={`${scenario}:${locale}`}
          id={fixture.id}
          locale={locale}
          initial={scenario === 'loading' ? undefined : initial}
          search={fixture.search}
          transport={
            scenario === 'loading' ? { ...fixture.transport, read: () => new Promise(() => {}) } : fixture.transport
          }
        />
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Patterns/Catalogue/Work parts',
  component: WorkPartsExample,
  parameters: { layout: 'fullscreen' },
  args: { scenario: 'current' },
} satisfies Meta<typeof WorkPartsExample>;
export default meta;
type Story = StoryObj<typeof meta>;
async function proposeCorrection(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: m.work_parts_correct() }));
  await userEvent.click(await canvas.findByRole('button', { name: m.relation_open() }));
  const position = await canvas.findByLabelText(
    pickText(bundledRelease.properties['schema:position']!.labels, getLocale()).text,
  );
  await userEvent.clear(position);
  await userEvent.type(position, '10');
  await userEvent.click(await canvas.findByRole('button', { name: m.relation_propose() }));
  const confirmation = await canvas.findByRole('group', {
    name: m.candidate_confirm_title({ action: m.relation_propose() }),
  });
  await userEvent.click(within(confirmation).getByRole('button', { name: m.relation_propose() }));
  return canvas;
}
export const Current: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await proposeCorrection(canvasElement);
    await expect(
      canvas.findByText(m.work_parts_candidate({ candidate: '00000000-0000-4000-8000-000000000804' })),
    ).resolves.toBeVisible();
  },
};
export const Partial: Story = {
  args: { scenario: 'partial' },
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const first = await canvas.findByRole('link', { name: 'Volume Two' });
    const row = first.closest('li')!;
    const heading = within(row).getByRole('heading', { name: 'Volume Two', level: 2 });
    await expect(first).toHaveAttribute('aria-labelledby', heading.id);
    first.focus();
    await expect(first).toHaveFocus();
    await userEvent.tab();
    await expect(row.querySelectorAll('a')[1]!).toHaveFocus();
    const citation = within(row).getByRole('link', { name: 'https://example.org/contents' });
    citation.focus();
    await expect(citation).toHaveFocus();
    await userEvent.tab();
    await expect(within(row).getByRole('button', { name: m.work_parts_correct() })).toHaveFocus();
    await userEvent.tab();
    await expect(row.querySelector('summary')!).toHaveFocus();
    const article = first.closest('article')!;
    const page = within(article);
    const document = canvasElement.ownerDocument;
    const view = document.defaultView!;
    const width = document.documentElement.clientWidth;
    const touch = width < 768 || view.matchMedia('(pointer: coarse)').matches;
    const contained = (element: HTMLElement) => {
      const bounds = element.getBoundingClientRect();
      expect(bounds.width).toBeGreaterThan(0);
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(width + 1);
      expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
    };
    const target = (element: HTMLElement) => {
      contained(element);
      if (touch) {
        const bounds = element.getBoundingClientRect();
        expect(bounds.height).toBeGreaterThanOrEqual(44);
        expect(bounds.width).toBeGreaterThanOrEqual(44);
      }
    };
    const readableResults = () => {
      contained(article);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width + 1);
      for (const link of within(page.getByRole('list')).getAllByRole('link')) {
        expect(link).toBeVisible();
        expect(view.getComputedStyle(link).whiteSpace).toBe('normal');
        const range = document.createRange();
        range.selectNodeContents(link);
        for (const rect of range.getClientRects()) {
          expect(rect.left).toBeGreaterThanOrEqual(0);
          expect(rect.right).toBeLessThanOrEqual(width + 1);
        }
      }
    };
    for (const name of [
      m.work_parts_correct(),
      m.work_parts_more(),
      m.work_parts_restart(),
      m.work_parts_draft(),
      m.candidate_reload(),
    ]) {
      target(page.getByRole('button', { name }));
    }
    target(first);
    target(article.querySelector('a')!);
    target(page.getByRole('combobox', { name: m.work_parts_relation() }));
    const summaries = [...article.querySelectorAll<HTMLElement>('summary')];
    expect(summaries).toHaveLength(2);
    summaries.forEach(target);
    const summary = summaries[0]!;
    summary.focus();
    await expect(summary).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(summary.parentElement).toHaveAttribute('open');
    readableResults();
    await userEvent.keyboard(' ');
    await expect(summary.parentElement).not.toHaveAttribute('open');
    await expect(first).toHaveAttribute('href', expect.stringContaining('/subjects/'));
    await expect(page.getByRole('link', { name: 'https://example.org/contents' })).toHaveAttribute(
      'href',
      'https://example.org/contents',
    );
    await userEvent.click(await canvas.findByRole('button', { name: m.work_parts_more() }));
    await expect(canvas.findByRole('link', { name: 'Volume Ten' })).resolves.toBeVisible();
    const continued = page.getByRole('link', { name: 'Volume Ten' });
    target(continued);
    await expect(continued).toHaveAttribute('href', expect.stringContaining('/subjects/'));
    await expect(continued.getAttribute('href')).not.toBe(first.getAttribute('href'));
    await expect(page.queryByRole('link', { name: 'Volume Two' })).toBeNull();
    readableResults();
    await userEvent.click(page.getByRole('button', { name: m.candidate_reload() }));
    await waitFor(() => expect(article).toHaveAttribute('aria-busy', 'false'));
    await expect(page.getByRole('link', { name: 'Volume Ten' })).toHaveAttribute(
      'href',
      continued.getAttribute('href'),
    );
    await userEvent.click(page.getByRole('button', { name: m.work_parts_restart() }));
    await expect(page.findByRole('link', { name: 'Volume Two' })).resolves.toBeVisible();
    readableResults();
    await userEvent.click(page.getByRole('button', { name: m.work_parts_correct() }));
    const draftSummary = article.querySelector<HTMLElement>(':scope > div > section > details > summary');
    await expect(draftSummary).not.toBeNull();
    target(draftSummary!);
    await expect(page.getByRole('button', { name: m.relation_open() })).toBeVisible();
  },
};
export const NoPosition: Story = { args: { scenario: 'no-position' } };
export const MissingAssertion: Story = {
  args: { scenario: 'missing-assertion' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Volume Two', level: 2 })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Volume Two' })).toHaveAttribute(
      'href',
      expect.stringContaining('/subjects/'),
    );
    await expect(canvas.getByText(m.work_parts_assertion_unavailable())).toBeVisible();
    await expect(canvas.queryByRole('button', { name: m.work_parts_correct() })).toBeNull();
  },
};
export const LongMultilingual: Story = {
  args: { scenario: 'long-multilingual' },
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const heading = canvas.getByRole('heading', { name: longPartTitle, level: 2 });
    await expect(heading).toHaveAttribute('lang', 'ja');
    const link = canvas.getByRole('link', { name: longPartTitle });
    await expect(link).toHaveAttribute('lang', 'ja');
    await expect(link).toHaveAttribute('aria-labelledby', heading.id);
    link.focus();
    await expect(link).toHaveFocus();
    await userEvent.tab();
    await expect(heading.closest('li')!.querySelectorAll('a')[1]!).toHaveFocus();
  },
};
export const Unresolved: Story = {
  args: { scenario: 'unresolved' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const heading = canvas.getByRole('heading', { name: m.work_parts_unresolved(), level: 2 });
    const row = within(heading.closest('li')!);
    await expect(row.queryByRole('link', { name: m.work_parts_unresolved() })).toBeNull();
    await expect(row.getByRole('link', { name: 'https://example.org/contents' })).toBeVisible();
    await expect(row.getByRole('button', { name: m.work_parts_correct() })).toBeVisible();
    const summary = heading.closest('li')!.querySelector('summary')!;
    await expect(summary.parentElement).not.toHaveAttribute('open');
    summary.focus();
    await userEvent.keyboard('{Enter}');
    await expect(summary.parentElement).toHaveAttribute('open');
  },
};
export const Empty: Story = { args: { scenario: 'empty' } };
export const Denied: Story = { args: { scenario: 'denied' } };
export const Stale: Story = { args: { scenario: 'stale' } };
export const Unavailable: Story = { args: { scenario: 'unavailable' } };
export const Pending: Story = { args: { scenario: 'pending' } };
export const Uncertain: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = await proposeCorrection(canvasElement);
    await expect(canvas.findByRole('alert')).resolves.toHaveTextContent(m.candidate_unavailable());
  },
};
export const Loading: Story = { args: { scenario: 'loading' } };

// Canonical additions; the original fixtures, exports and plays above remain intact.
// Authored UNRUN: browser plays own keyboard, focus and actual layout evidence.
// Supplied rich data exercises presentation, not admission of additional native qualifiers.
function suppliedComposition(fixture: ReturnType<typeof workPartsFixture>) {
  const initial = fixture.snapshot();
  if (!initial.ok || !initial.stream) throw new Error('Expected a supplied composition');
  const row = initial.rows[0]!;
  row.summary = { ...row.summary!, label: { value: longPartTitle, language: 'ja' } };
  row.statement = structuredClone(row.statement!);
  row.statement.qualifiers.push({
    property: { id: 'schema:name', data_type: 'monolingualtext' },
    value: {
      type: 'value',
      content: { text: 'Édition originale — toutes les informations conservées', language: 'fr' },
    },
  });
  row.statement.references.push({
    hash: 'complete-second-reference',
    parts: [
      {
        property: { id: 'schema:url', data_type: 'url' },
        value: { type: 'value', content: 'https://archive.example.test/' + 'complete-reference/'.repeat(12) },
      },
    ],
  });
  initial.labels['schema:name'] = { text: 'معلومات الطبعة الأصلية كاملة', lang: 'ar' };
  return initial;
}
let familyMount: { fixtures: ReturnType<typeof workPartsFixture>[]; initial: ReturnType<typeof suppliedComposition>[] };
function WorkPartsFamilyExample({ paired = false, rtl = false }: { paired?: boolean; rtl?: boolean }) {
  const locale = getLocale();
  const supplied = useMemo(() => {
    const fixtures = Array.from({ length: paired ? 2 : 1 }, () => workPartsFixture('partial', locale));
    const value = { fixtures, initial: fixtures.map(suppliedComposition) };
    familyMount = value;
    return value;
  }, [locale, paired]);
  return (
    <PatternStory visitor="Signed In">
      <AppShell>
        <div dir={rtl ? 'rtl' : 'ltr'} className="min-w-0 space-y-12">
          {supplied.fixtures.map((fixture, index) => (
            <WorkPartsPage
              key={`${locale}:${index}`}
              id={fixture.id}
              locale={locale}
              initial={supplied.initial[index]}
              search={fixture.search}
              transport={fixture.transport}
            />
          ))}
        </div>
      </AppShell>
    </PatternStory>
  );
}
async function readableComposition(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const primary = await canvas.findByRole('link', { name: longPartTitle });
  const row = primary.closest('li')!;
  const article = primary.closest('article')!;
  const heading = within(row).getByRole('heading', { level: 2, name: longPartTitle });
  await expect(row).toHaveAttribute('aria-labelledby', heading.id);
  await expect(primary).toHaveAttribute('aria-labelledby', heading.id);
  await expect(heading).toHaveAttribute('lang', 'ja');
  await expect(within(row).getByRole('heading', { level: 3, name: m.sources_citations() })).toBeVisible();
  await expect(within(row).getByText('Édition originale — toutes les informations conservées')).toBeVisible();
  await expect(within(row).getByText('معلومات الطبعة الأصلية كاملة')).toHaveAttribute('lang', 'ar');
  await expect(row.querySelector('[data-slot="list-row-control"]')).toBeNull();
  await expect(row.querySelector('a a, a button, a summary')).toBeNull();
  const fixture = familyMount.fixtures[0]!;
  const initial = familyMount.initial[0]!;
  if (!initial.ok) throw new Error('Expected supplied reading data');
  await expect(primary).toHaveAttribute('href', expect.stringContaining(initial.rows[0]!.summary!.id));
  const before = fixture.calls.length;
  const document = canvasElement.ownerDocument;
  const view = document.defaultView!;
  const width = document.documentElement.clientWidth;
  const touch = width < 768 || view.matchMedia('(pointer: coarse)').matches;
  const contained = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(width + 1);
    expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
  };
  contained(article);
  contained(heading);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width + 1);
  expect(view.getComputedStyle(heading).whiteSpace).toBe('normal');
  expect(view.getComputedStyle(heading).webkitLineClamp).toBe('none');
  const range = document.createRange();
  for (const element of [heading, ...row.querySelectorAll<HTMLElement>('p,a:not([data-slot="list-row-link"])')]) {
    range.selectNodeContents(element);
    for (const rect of range.getClientRects()) {
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(width + 1);
    }
  }
  const controls = [...row.querySelectorAll<HTMLElement>('a,button,summary')];
  primary.focus();
  await expect(primary).toHaveFocus();
  for (const control of controls.slice(1)) {
    await userEvent.tab();
    await expect(control).toHaveFocus();
    contained(control);
    // Actual targets, not DOM-construction evidence.
    if (touch && control.matches('button,summary')) {
      const rect = control.getBoundingClientRect();
      expect(rect.width).toBeGreaterThanOrEqual(44);
      expect(rect.height).toBeGreaterThanOrEqual(44);
    }
    expect(view.getComputedStyle(control).position).toBe('relative');
    expect(Number(view.getComputedStyle(control).zIndex)).toBeGreaterThan(0);
    expect(view.getComputedStyle(control).outlineStyle).not.toBe('none');
  }
  const summary = row.querySelector('summary')!;
  await userEvent.keyboard('{Enter}');
  await expect(summary.parentElement).toHaveAttribute('open');
  expect(row.querySelector('pre')!.textContent).toBe(JSON.stringify(initial.rows[0]!.statement, null, 2));
  for (const reference of [initial.rows[0]!.holder, initial.stream!.property, initial.rows[0]!.statementId]) {
    await expect(row.querySelector('dl')).toHaveTextContent(reference);
  }
  await userEvent.keyboard(' ');
  await expect(summary.parentElement).not.toHaveAttribute('open');
  expect(fixture.calls).toHaveLength(before);
  await userEvent.click(within(row).getByRole('button', { name: m.work_parts_correct() }));
  const correctionSummary = article.querySelector<HTMLElement>(':scope > div > section > details > summary')!;
  await expect(correctionSummary).not.toBeNull();
  correctionSummary.focus();
  await userEvent.keyboard('{Enter}');
  await expect(correctionSummary.parentElement).toHaveAttribute('open');
  await expect(within(article).getByRole('button', { name: m.relation_open() })).toBeVisible();
  expect(fixture.calls).toHaveLength(before);
}
export const SuppliedCompositionPhone: Story = {
  render: () => <WorkPartsFamilyExample />,
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => readableComposition(canvasElement),
};
export const SuppliedCompositionDesktopRTL: Story = {
  render: () => <WorkPartsFamilyExample rtl />,
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  play: async ({ canvasElement }) => readableComposition(canvasElement),
};
export const IndependentMounts: Story = {
  render: () => <WorkPartsFamilyExample paired />,
  play: async ({ canvasElement }) => {
    const articles = [...canvasElement.querySelectorAll<HTMLElement>('article')];
    await waitFor(() => expect(articles).toHaveLength(2));
    const controls = articles.map((article) => {
      const select = article.querySelector('select') as unknown as Element & { id: string; value: string };
      expect(select).toBe(within(article).getByRole('combobox', { name: m.work_parts_relation() }));
      return select;
    });
    expect(controls[0]!.id).not.toBe(controls[1]!.id);
    const fixtures = familyMount.fixtures;
    const original = controls[0]!.value;
    for (const [index, article] of articles.entries()) {
      const label = article.querySelector<HTMLLabelElement>('label')!;
      expect(label.htmlFor).toBe(controls[index]!.id);
      expect(label.control).toBe(controls[index]);
      await userEvent.click(label);
      await expect(controls[index]!).toHaveFocus();
    }
    const initial = familyMount.initial[0]!;
    if (!initial.ok) throw new Error('Expected supplied streams');
    const alternative = initial.streams.find((stream) => stream.direction === 'inverse' && stream.key !== original)!;
    await userEvent.selectOptions(
      within(articles[0]!).getByRole('combobox', { name: m.work_parts_relation() }),
      alternative.key,
    );
    await waitFor(() => expect(controls[0]!).not.toBeDisabled());
    expect(controls[0]!.value).toBe(alternative.key);
    expect(controls[1]!.value).toBe(original);
    expect(fixtures[1]!.calls).toHaveLength(0);
    expect(fixtures[0]!.calls).toHaveLength(2);
    await userEvent.selectOptions(
      within(articles[1]!).getByRole('combobox', { name: m.work_parts_relation() }),
      alternative.key,
    );
    await waitFor(() => expect(controls[1]!).not.toBeDisabled());
    expect(fixtures[0]!.calls).toHaveLength(2);
    expect(fixtures[1]!.calls).toHaveLength(2);
    await userEvent.selectOptions(
      within(articles[0]!).getByRole('combobox', { name: m.work_parts_relation() }),
      original,
    );
    await waitFor(() =>
      expect(within(articles[0]!).getByRole('button', { name: m.work_parts_correct() })).toBeVisible(),
    );
    const calls = fixtures[0]!.calls.length;
    const row = articles[0]!.querySelector('li')!;
    const summary = row.querySelector('summary')!;
    summary.focus();
    await userEvent.keyboard('{Enter}');
    await expect(summary.parentElement).toHaveAttribute('open');
    await userEvent.click(within(row).getByRole('button', { name: m.work_parts_correct() }));
    await expect(articles[0]!.querySelector(':scope > div > section > details > summary')).not.toBeNull();
    await expect(articles[1]!.querySelector(':scope > div > section > details > summary')).toBeNull();
    expect(fixtures[0]!.calls).toHaveLength(calls);
    expect(fixtures[1]!.calls).toHaveLength(2);
  },
};
