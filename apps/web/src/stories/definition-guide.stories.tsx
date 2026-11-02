import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { DefinitionGuide, DefinitionGuideContent } from '../features/catalogue/definition-guide-view';
import { definitionGuideFixture, type GuideScenario } from '../kernel/fake/definition-guide';
import { definitionText, type GuideRelease } from '../features/catalogue/definition-guide';
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

function IndependentGuideStory() {
  const locale = getLocale();
  const fixture = useMemo(() => definitionGuideFixture(), [locale]);
  return (
    <PatternStory path="/catalogue/definitions" visitor="Signed Out">
      <AppShell>
        <div className="flex min-w-0 flex-col gap-12">
          <DefinitionGuide locale={locale} address={fixture.address} transport={fixture.transport} />
          <DefinitionGuide locale={locale} address={fixture.address} transport={fixture.transport} />
        </div>
      </AppShell>
    </PatternStory>
  );
}

export const IndependentGuides: Story = {
  render: () => <IndependentGuideStory />,
  parameters: {
    docs: {
      description: {
        story:
          'UNRUN: two actual same-address guides share the ordinary read query while retaining independent native selection and label associations. Uses the recorded active release through the existing fixture transport.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pickers = await canvas.findAllByRole('combobox', { name: m.catalogue_create_type() });
    await expect(pickers).toHaveLength(2);
    await expect(pickers[0]!.id).not.toBe(pickers[1]!.id);
    const labels = canvas.getAllByText(m.catalogue_create_type(), { selector: 'label' });
    for (const [index, label] of labels.entries()) {
      await expect((label as HTMLLabelElement).control).toBe(pickers[index]);
      await userEvent.click(label);
      await expect(pickers[index]).toHaveFocus();
    }
    await userEvent.selectOptions(pickers[1]!, 'schema:Recipe');
    await expect(pickers[0]).toHaveValue('schema:Book');
    await expect(pickers[1]).toHaveValue('schema:Recipe');
    const guides = canvas.getAllByRole('article');
    const locale = getLocale();
    const book = definitionText(definitions.release.types['schema:Book'].labels, locale).text!;
    const recipe = definitionText(definitions.release.types['schema:Recipe'].labels, locale).text!;
    await expect(within(guides[0]!).getByRole('heading', { level: 2, name: book })).toBeVisible();
    await expect(within(guides[1]!).getByRole('heading', { level: 2, name: recipe })).toBeVisible();
  },
};

function LongGuideStory() {
  const locale = getLocale();
  // Constructed long-label presentation inputs, retaining recorded constraint/reference values. Not a new release.
  const release = useMemo(() => {
    const copy = { ...structuredClone(definitions.release), digest: definitions.digest } as GuideRelease;
    for (const labels of [
      copy.types['schema:Book']!.labels,
      copy.properties['schema:author']!.labels,
      copy.properties['schema:position']!.labels,
    ]) {
      labels[locale] = Array(12).fill(definitionText(labels, locale).text).join(' · ');
    }
    return copy;
  }, [locale]);
  const type = release.types['schema:Book']!;
  const summary = definitionText(type.labels, locale);
  const description = definitionText(type.descriptions, locale);
  const descriptor = {
    typeId: 'schema:Book',
    releaseDigest: release.digest,
    label: summary.text,
    language: summary.lang,
    parents: [],
    description: description.text || null,
    descriptionLanguage: description.lang,
    definition: type,
    properties: Object.fromEntries(type.properties.map((id) => [id, release.properties[id]!])),
  };
  const read = { ok: true as const, pin: 'active' as const, descriptor };
  return (
    <PatternStory path="/catalogue/definitions" visitor="Signed Out">
      <AppShell>
        <div className="flex min-w-0 flex-col gap-12">
          <DefinitionGuideContent locale={locale} address={{ type: 'schema:Book' }} read={read} retry={() => {}} />
          <DefinitionGuideContent
            locale={locale}
            address={{ type: 'schema:Book', property: 'schema:author' }}
            read={read}
            retry={() => {}}
          />
        </div>
      </AppShell>
    </PatternStory>
  );
}

export const LongNamesAndPhoneKeyboard: Story = {
  render: () => <LongGuideStory />,
  globals: { viewport: { value: 'phone390', isRotated: false } },
  parameters: {
    docs: {
      description: {
        story:
          'UNRUN: constructed long localized names on the actual list and selected-field components at 390px. The recorded active digest, regex and qualifier constraints remain exact. Keyboard disclosure, target geometry, focus and full text ranges are authored browser witnesses, not measured results.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const document = canvasElement.ownerDocument;
    const guides = canvas.getAllByRole('article');
    await expect(document.documentElement.clientWidth).toBe(390);
    const geometry = async () => {
      for (const guide of guides) {
        const bounds = guide.getBoundingClientRect();
        await expect(bounds.left).toBeGreaterThanOrEqual(0);
        await expect(bounds.right).toBeLessThanOrEqual(390);
        await expect(guide.scrollWidth).toBeLessThanOrEqual(guide.clientWidth + 1);
        // Closed native details have no visible target or text geometry until expanded.
        for (const target of guide.querySelectorAll<HTMLElement>('a, select, summary')) {
          if (target.getClientRects().length === 0) continue;
          const rect = target.getBoundingClientRect();
          await expect(rect.width).toBeGreaterThanOrEqual(44);
          await expect(rect.height).toBeGreaterThanOrEqual(44);
          await expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 1);
          await expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
        }
        for (const text of guide.querySelectorAll<HTMLElement>('h1, h2, h3, p, label, a, summary, dt, dd, code')) {
          if (text.getClientRects().length === 0) continue;
          const box = text.getBoundingClientRect();
          const walker = document.createTreeWalker(text, 4 /* SHOW_TEXT */);
          while (walker.nextNode()) {
            if (!walker.currentNode.textContent?.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(walker.currentNode);
            for (const line of range.getClientRects()) {
              await expect(line.left).toBeGreaterThanOrEqual(Math.max(bounds.left, box.left) - 1);
              await expect(line.right).toBeLessThanOrEqual(Math.min(bounds.right, box.right) + 1);
            }
          }
        }
      }
      await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    };
    await geometry();
    const fieldGuide = within(guides[1]!);
    const release = fieldGuide.getByText(m.guide_active()).closest('summary')!;
    release.focus();
    await expect(release).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(release.parentElement).toHaveAttribute('open');
    await expect(fieldGuide.getByText(definitions.digest)).toBeVisible();
    await geometry();
    const qualifierHeading = fieldGuide.getByRole('heading', { level: 3, name: m.guide_qualifiers() });
    const qualifiers = qualifierHeading.closest('section')!.querySelectorAll('summary');
    for (const summary of qualifiers) {
      summary.focus();
      await expect(summary).toHaveFocus();
      await expect(getComputedStyle(summary).display).toBe('list-item');
      await expect(getComputedStyle(summary).listStyleType).not.toBe('none');
      await userEvent.keyboard(' ');
      await expect(summary.parentElement).toHaveAttribute('open');
      await geometry();
    }
    const identifier = fieldGuide.getAllByText(m.guide_identifier()).at(-1)!.closest('summary')!;
    identifier.focus();
    await userEvent.keyboard('{Enter}');
    await expect(identifier.parentElement).toHaveAttribute('open');
    await expect(fieldGuide.getByText('schema:author', { selector: 'code' })).toBeVisible();
    await expect(fieldGuide.getByText('^[1-9][0-9]{0,3}$', { selector: 'code' })).toBeVisible();
    await geometry();
    await userEvent.tab();
    await expect(fieldGuide.getByRole('link', { name: m.guide_fields() })).toHaveFocus();
  },
};
