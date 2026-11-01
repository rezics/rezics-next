import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { DefinitionGuide } from '../features/catalogue/definition-guide-view';
import { definitionGuideFixture, type GuideScenario } from '../kernel/fake/definition-guide';
import { definitionText } from '../features/catalogue/definition-guide';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import definitions from '../kernel/recorded/definitions-release.json';

function GuideStory({ scenario = 'active' }: { scenario?: GuideScenario }) {
  const locale = getLocale();
  const fixture = useMemo(() => definitionGuideFixture(scenario), [scenario, locale]);
  return (
    <PatternStory path="/catalogue/definitions" visitor="Signed Out">
      <AppShell>
        <DefinitionGuide
          key={`${scenario}:${locale}`}
          locale={locale}
          address={{ ...fixture.address, returnTo: `/${locale}/catalogue/new` }}
          transport={fixture.transport}
        />
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Catalogue/Type and field guide',
  component: GuideStory,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
    docs: {
      description: {
        component:
          'Read-only released metadata and native editor return links. The two presentation cases use the recorded active bundle and an actual immutable historical bundle. Locale, theme and viewport are globals. Native binding/outcome proof and Web/Root visual review remain pending.',
      },
    },
  },
} satisfies Meta<typeof GuideStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ActiveType: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const picker = await canvas.findByRole('combobox', { name: m.catalogue_create_type() });
    await userEvent.selectOptions(picker, 'schema:Recipe');
    const name = definitionText(definitions.release.properties['schema:cookTime'].labels, getLocale()).text;
    const field = await canvas.findByRole('link', { name });
    expect(field.getAttribute('href')).toContain('property=schema%3AcookTime');
    expect(canvas.getByRole('link', { name: m.guide_back() })).toHaveAttribute('href', `/${getLocale()}/catalogue/new`);
  },
};
export const PinnedField: Story = {
  args: { scenario: 'pinned' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByText(m.guide_pinned()));
    expect(await canvas.findByText(/sha256:eb8bc8b/)).toBeVisible();
    expect(canvas.getByText(m.guide_integer())).toBeVisible();
    expect(canvas.getByText('min')).toBeVisible();
  },
};
export const MissingMeaning: Story = { args: { scenario: 'missing-meaning' } };
export const Empty: Story = { args: { scenario: 'empty' } };
export const Loading: Story = { args: { scenario: 'loading' } };
export const Denied: Story = { args: { scenario: 'denied' } };
export const InvalidRelease: Story = { args: { scenario: 'invalid' } };
export const UnavailableRetry: Story = {
  args: { scenario: 'unavailable' },
  globals: { viewport: { value: 'phone390', isRotated: false } },
  parameters: {
    docs: {
      description: {
        story:
          'UNRUN: actual read-only guide recovery and navigation at 390px measure Back, Retry, the native type picker, release disclosure and field links, including rendered label and page containment. Existing recovery behavior is retained. Browser, native and visual verification are deferred.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.guide_unavailable());
    const document = canvasElement.ownerDocument;
    const guide = canvas.getByRole('article');
    await expect(document.documentElement.clientWidth).toBe(390);
    const phoneGeometry = async () => {
      const bounds = guide.getBoundingClientRect();
      await expect(bounds.width).toBeGreaterThan(0);
      await expect(bounds.left).toBeGreaterThanOrEqual(0);
      await expect(bounds.right).toBeLessThanOrEqual(390);
      await expect(guide.scrollWidth).toBeLessThanOrEqual(guide.clientWidth + 1);
      await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
      for (const target of guide.querySelectorAll<HTMLElement>('button, a, select, summary')) {
        const rect = target.getBoundingClientRect();
        await expect(rect.height).toBeGreaterThanOrEqual(44);
        await expect(rect.width).toBeGreaterThanOrEqual(44);
        await expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 1);
        await expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
      }
      for (const label of guide.querySelectorAll<HTMLElement>('h1, h2, h3, p, label, button, a, summary')) {
        const box = label.getBoundingClientRect();
        const walker = document.createTreeWalker(label, 4 /* SHOW_TEXT */);
        while (walker.nextNode()) {
          if (!walker.currentNode.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(walker.currentNode);
          for (const line of range.getClientRects()) {
            await expect(line.left).toBeGreaterThanOrEqual(box.left - 1);
            await expect(line.right).toBeLessThanOrEqual(box.right + 1);
          }
        }
      }
    };
    await phoneGeometry();
    await userEvent.click(canvas.getByRole('button', { name: m.guide_retry() }));
    expect(await canvas.findByRole('combobox', { name: m.catalogue_create_type() })).toBeVisible();
    await expect(canvas.queryByRole('alert')).not.toBeInTheDocument();
    await phoneGeometry();
    const releaseSummary = canvas.getByText(m.guide_active()).closest('summary')!;
    releaseSummary.focus();
    await userEvent.keyboard('{Enter}');
    await expect(releaseSummary.parentElement).toHaveAttribute('open');
    await expect(canvas.getByText(definitions.digest)).toBeVisible();
    await phoneGeometry();
    await userEvent.keyboard('{Enter}');
    await expect(releaseSummary.parentElement).not.toHaveAttribute('open');
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.catalogue_create_type() }), 'schema:Recipe');
    const name = definitionText(definitions.release.properties['schema:cookTime'].labels, getLocale()).text;
    const field = await canvas.findByRole('link', { name });
    await expect(field).toHaveAttribute(
      'href',
      `/${getLocale()}/catalogue/definitions?type=schema%3ARecipe&property=schema%3AcookTime&returnTo=${encodeURIComponent(`/${getLocale()}/catalogue/new`)}`,
    );
    await expect(canvas.getByRole('link', { name: m.guide_back() })).toHaveAttribute(
      'href',
      `/${getLocale()}/catalogue/new`,
    );
    await phoneGeometry();
  },
};
