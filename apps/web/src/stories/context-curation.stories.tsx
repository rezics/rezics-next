import { pageText } from '../features/pages/data';
import { ContextComparisonView } from '../features/catalogue/context-curation-view';
import { contextFixture } from '../kernel/fake/context-curation';
import type { CandidateRead } from '../subject/candidates';
import { getLocale } from '../paraglide/runtime';
import { subjectHref } from '../subject/subject-href';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ContextCurationStory } from '../features/catalogue/context-curation-story';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { pagePaths, PatternStory } from './page';

const meta = {
  title: 'Pages/Catalogue/Context review',
  component: ContextCurationStory,
  decorators: [
    (Story) => (
      <PatternStory visitor="Signed In" path={pagePaths.subject}>
        <AppShell>
          <Story />
        </AppShell>
      </PatternStory>
    ),
  ],
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ContextCurationStory>;
export default meta;
type Story = StoryObj<typeof meta>;
async function open(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: m.candidate_entry() }));
  return canvas;
}
async function replace(canvasElement: HTMLElement) {
  const canvas = await open(canvasElement);
  await userEvent.selectOptions(await canvas.findByRole('combobox', { name: m.context_mode() }), 'replace');
  for (const choice of canvas.getAllByRole('checkbox'))
    if (choice.getAttribute('aria-checked') === 'true') await userEvent.click(choice);
  await userEvent.click(canvas.getAllByRole('checkbox').at(-1)!);
  await userEvent.click(canvas.getByRole('button', { name: m.context_adopt() }));
  return canvas;
}
async function confirm(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const heading = canvas.getByRole('heading', { name: m.candidate_confirm_title({ action: m.context_adopt() }) });
  await userEvent.click(within(heading.parentElement!).getByRole('button', { name: m.context_adopt() }));
  return canvas;
}
export const Inherited: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await canvas.findByText(m.context_inherited());
    expect(canvas.getByRole('link', { name: m.candidate_view_public() })).toBeTruthy();
  },
};
export const Replaced: Story = {
  args: { scenario: 'replaced' },
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await canvas.findByText(m.context_replaced());
  },
};
export const Suppressed: Story = {
  args: { scenario: 'suppressed' },
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await canvas.findByText(m.context_suppressed());
  },
};
export const Unresolved: Story = {
  args: { scenario: 'unresolved' },
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await canvas.findByText(m.context_unresolved());
  },
};
export const Saved: Story = {
  play: async ({ canvasElement }) => {
    await replace(canvasElement);
    const canvas = await confirm(canvasElement);
    await canvas.findByText(m.context_saved());
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_reload() }));
    await canvas.findByText(m.context_replaced());
  },
};
export const Conflict: Story = {
  args: { scenario: 'conflict' },
  play: async ({ canvasElement }) => {
    await replace(canvasElement);
    const canvas = await confirm(canvasElement);
    await canvas.findByText(m.candidate_draft_stale());
    expect(canvas.getByRole('button', { name: m.context_adopt() })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_reload() }));
    await canvas.findByRole('combobox', { name: m.context_mode() });
    expect(canvas.getAllByRole('checkbox').at(-1)!).toBeChecked();
    await userEvent.click(canvas.getByRole('button', { name: m.context_adopt() }));
    await confirm(canvasElement);
    await canvas.findByText(m.context_saved());
  },
};
export const Denied: Story = {
  args: { scenario: 'adopt-denied' },
  play: async ({ canvasElement }) => {
    await replace(canvasElement);
    const canvas = await confirm(canvasElement);
    await canvas.findByText(m.candidate_denied());
    expect(canvas.queryByRole('combobox', { name: m.context_mode() })).toBeNull();
  },
};
export const Invalid: Story = {
  args: { scenario: 'invalid' },
  play: async ({ canvasElement }) => {
    await replace(canvasElement);
    const canvas = await confirm(canvasElement);
    await canvas.findByText(m.candidate_invalid());
  },
};
export const Unavailable: Story = {
  args: { scenario: 'unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await canvas.findByText(m.candidate_unavailable());
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_reload() }));
    await canvas.findByText(m.candidate_unavailable());
  },
};
export const Empty: Story = {
  args: { scenario: 'empty' },
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await canvas.findByText(m.candidate_empty());
  },
};
export const Loading: Story = {
  args: { scenario: 'loading' },
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await canvas.findByText(m.candidate_loading());
  },
};

// Constructed supplied reading examples, not a native fixture campaign or publication proof.
const suppliedProperty = 'schema:description';
const suppliedName = '読者の選択 — Gemeinschaft für gemeinsame Lektüre et les récits partagés '.repeat(3).trim();
const publicValue = 'Current public reading / 現在の公開内容 / Öffentliche Beschreibung — '.repeat(12).trim();
const selectedValue = 'Selected editorial reading / 選択した編集内容 / Sélection des lecteurs — '.repeat(12).trim();
function suppliedComparison(locale: string): Extract<CandidateRead, { ok: true }> {
  const fixture = contextFixture('replaced', locale);
  const statement = (value: string) => ({
    ...fixture.candidate.statement,
    property: { id: suppliedProperty, data_type: 'string' as const },
    value: { type: 'value' as const, content: value },
  });
  const inherited = [statement(publicValue)];
  const selected = [statement(selectedValue)];
  return {
    ok: true,
    public: {
      ...fixture.publicRead,
      subject: { ...fixture.publicRead.subject, statements: { [suppliedProperty]: inherited } },
    },
    fields: [],
    names: {},
    page: null,
    contextReview: {
      context: { ...fixture.context, labels: { [locale]: suppliedName } },
      reading: {
        ...fixture.reading,
        subject: { ...fixture.reading.subject, statements: { [suppliedProperty]: selected } },
      },
      inherited,
      selected,
      adoption: { mode: 'replace', head: 7 },
    },
  };
}
function SuppliedComparisons({ rtl = false }: { rtl?: boolean }) {
  const locale = getLocale();
  const read = suppliedComparison(locale);
  return (
    <article dir={rtl ? 'rtl' : undefined} className="mx-auto min-w-0 max-w-4xl space-y-8 p-4 sm:p-8">
      <h2 className="text-xl font-semibold">{m.context_title()}</h2>
      <ContextComparisonView read={read} property={suppliedProperty} locale={locale} />
      <ContextComparisonView read={read} property={suppliedProperty} locale={locale} />
    </article>
  );
}
async function suppliedComparisonJourney(canvasElement: HTMLElement) {
  const panels = canvasElement.querySelectorAll<HTMLElement>('[data-context-comparison]');
  await expect(panels).toHaveLength(2);
  const locale = getLocale();
  const read = suppliedComparison(locale);
  const expectedHref = subjectHref(
    { id: read.public.subject.id, label: pageText(read.public.subject.labels, locale).text },
    locale,
  ).href;
  for (const panel of panels) {
    const canvas = within(panel);
    await expect(canvas.getByRole('heading', { level: 3 })).toHaveTextContent(suppliedName);
    await expect(canvas.getAllByRole('heading', { level: 4 })).toHaveLength(2);
    await expect(canvas.getByText(m.context_authority())).toBeVisible();
    await expect(canvas.getByRole('status')).toHaveTextContent(m.context_replaced());
    const sections = panel.querySelectorAll('section');
    await expect(sections).toHaveLength(2);
    await expect(sections[0]).toHaveTextContent(publicValue);
    await expect(sections[1]).toHaveTextContent(selectedValue);
    await expect(sections[0]!.querySelector('[data-context-values]')).toHaveClass('group');
    const link = canvas.getByRole('link', { name: m.candidate_view_public() });
    await expect(link).toHaveAttribute('href', expectedHref);
    // Native tab navigation, actual browser geometry and full wrapping; authored UNRUN.
    link.focus();
    await userEvent.tab();
    await userEvent.tab({ shift: true });
    await expect(link).toHaveFocus();
    const style = getComputedStyle(link);
    await expect(style.outlineStyle).not.toBe('none');
    await expect(parseFloat(style.outlineWidth)).toBeGreaterThanOrEqual(2);
    const rect = link.getBoundingClientRect();
    await expect(rect.width).toBeGreaterThanOrEqual(44);
    await expect(rect.height).toBeGreaterThanOrEqual(44);
    for (const node of [panel, link, ...sections]) {
      await expect(node.scrollWidth).toBeLessThanOrEqual(node.clientWidth + 1);
      await expect(node.scrollHeight).toBeLessThanOrEqual(node.clientHeight + 1);
    }
  }
}
const comparisonViewports = {
  options: {
    phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
    desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
  },
};
export const SuppliedLongComparisonPhone: Story = {
  render: () => <SuppliedComparisons />,
  parameters: { viewport: comparisonViewports },
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => suppliedComparisonJourney(canvasElement),
};
export const SuppliedLongComparisonDesktopRtl: Story = {
  render: () => <SuppliedComparisons rtl />,
  parameters: { viewport: comparisonViewports },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  play: async ({ canvasElement }) => suppliedComparisonJourney(canvasElement),
};

// Authored UNRUN: a local acceptance is separate from deliberate Context adoption.
export const LocalAcceptanceRemainsSeparate: Story = {
  args: { scenario: 'unresolved' },
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.candidate_review() }));
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_accept() }));
    const heading = canvas.getByRole('heading', { name: m.candidate_confirm_title({ action: m.candidate_accept() }) });
    await expect(canvas.getByText(m.context_confirm_accept())).toBeVisible();
    await userEvent.click(within(heading.parentElement!).getByRole('button', { name: m.candidate_accept() }));
    await canvas.findByText(m.context_accepted());
    await expect(canvasElement.querySelector('[data-context-comparison] [role="status"]')).toHaveTextContent(
      m.context_unresolved(),
    );
  },
};
