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

function WorkPartsExample({ scenario }: { scenario: WorkPartsScenario | 'loading' }) {
  const locale = getLocale();
  const fixture = useMemo(
    () => workPartsFixture(scenario === 'loading' ? 'current' : scenario, locale),
    [scenario, locale],
  );
  return (
    <PatternStory visitor="Signed In">
      <AppShell>
        <WorkPartsPage
          key={`${scenario}:${locale}`}
          id={fixture.id}
          locale={locale}
          initial={scenario === 'loading' ? undefined : fixture.snapshot()}
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
export const MissingAssertion: Story = { args: { scenario: 'missing-assertion' } };
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
