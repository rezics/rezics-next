import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { SubjectTermsPage } from '../features/catalogue/subject-terms-page';
import { catalogueTermsFixture, termsSubjectId, type TermsScenario } from '../kernel/fake/catalogue-terms';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

function TermsStory({ scenario = 'ready' }: { scenario?: TermsScenario }) {
  const locale = getLocale();
  const fixture = useMemo(() => catalogueTermsFixture(scenario, locale), [scenario, locale]);
  return (
    <PatternStory
      path={`/subjects/${termsSubjectId}/original-film/terms`}
      visitor={scenario === 'signed-out' ? 'Signed Out' : 'Signed In'}
    >
      <AppShell>
        <SubjectTermsPage
          key={`${scenario}:${locale}`}
          id={termsSubjectId}
          locale={locale}
          session={scenario === 'signed-out' ? 'signed-out' : 'signed-in'}
          transport={fixture.transport}
        />
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Catalogue/Subject terms',
  component: TermsStory,
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
          'Explicit multilingual edits through the generated native terms client and a read/ETag sample seam. Samples establish neither runtime availability nor native or visual acceptance. Select locale, theme and viewport with toolbar globals.',
      },
    },
  },
} satisfies Meta<typeof TermsStory>;
export default meta;
type Story = StoryObj<typeof meta>;

async function fill(canvasElement: HTMLElement, value = 'Corrected title') {
  const canvas = within(canvasElement);
  await userEvent.selectOptions(await canvas.findByRole('combobox', { name: m.catalogue_create_language() }), 'en');
  const label = within(canvas.getByRole('group', { name: m.catalogue_create_label() }));
  await userEvent.selectOptions(label.getByRole('combobox'), 'set');
  await userEvent.clear(label.getByRole('textbox'));
  if (value) await userEvent.type(label.getByRole('textbox'), value);
  return canvas;
}
async function submit(canvasElement: HTMLElement) {
  const canvas = await fill(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.catalogue_terms_save() }));
  return canvas;
}

// Browser geometry belongs in the canonical story, not the DOM-only regression.
async function phoneControls(canvasElement: HTMLElement) {
  if (!matchMedia('(max-width: 767px), (pointer: coarse)').matches) return;
  const editor = canvasElement.querySelector('article')!;
  await expect(editor.scrollWidth).toBeLessThanOrEqual(editor.clientWidth);
  for (const control of editor.querySelectorAll<HTMLElement>('select, input, textarea, button, a')) {
    const bounds = control.getBoundingClientRect();
    await expect(bounds.height).toBeGreaterThanOrEqual(44);
    await expect(bounds.width).toBeGreaterThanOrEqual(44);
    await expect(bounds.left).toBeGreaterThanOrEqual(0);
    await expect(bounds.right).toBeLessThanOrEqual(document.documentElement.clientWidth);
  }
}

export const Ready: Story = {};
export const Loading: Story = { args: { scenario: 'loading' } };
export const SignedOut: Story = { args: { scenario: 'signed-out' } };
export const EmptyLanguage: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByRole('textbox', { name: m.catalogue_terms_new_language() }), 'it');
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_add_language() }));
    expect(await canvas.findByText(m.catalogue_terms_empty())).toBeVisible();
  },
};
export const PatchAndRemove: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await fill(canvasElement);
    await userEvent.selectOptions(
      within(canvas.getByRole('group', { name: m.catalogue_create_description() })).getByRole('combobox'),
      'remove',
    );
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_terms_save() }));
    expect(await canvas.findByText(m.catalogue_terms_saved())).toBeVisible();
    expect(canvas.getByText('元の映画')).toBeVisible();
    expect(canvas.getByText('Working title')).toBeVisible();
    expect(canvas.queryByRole('button', { name: m.catalogue_terms_save() })).toBeNull();
  },
};
export const Invalid: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await fill(canvasElement, '');
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_terms_save() }));
    expect(await canvas.findByText(m.catalogue_create_invalid(), { exact: true })).toHaveTextContent(
      m.catalogue_create_invalid(),
    );
    expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveAttribute('aria-invalid', 'true');
  },
};
export const StaleDraft: Story = {
  args: { scenario: 'stale' },
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = await fill(canvasElement);
    await phoneControls(canvasElement);
    const language = canvas.getByRole('combobox', { name: m.catalogue_create_language() });
    language.focus();
    await userEvent.tab();
    await expect(canvas.getByRole('textbox', { name: m.catalogue_terms_new_language() })).toHaveFocus();
    await expect(getComputedStyle(document.activeElement!).boxShadow).not.toBe('none');
    await userEvent.type(canvas.getByRole('textbox', { name: m.catalogue_terms_new_language() }), 'it');
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_add_language() }));
    const aliases = within(canvas.getByRole('group', { name: m.catalogue_create_aliases() }));
    await userEvent.selectOptions(aliases.getByRole('combobox'), 'set');
    const multiline = aliases.getByRole('textbox');
    await expect(multiline.tagName).toBe('TEXTAREA');
    await expect(multiline).toHaveAttribute('rows', '3');
    await userEvent.clear(multiline);
    await userEvent.type(multiline, 'Primo{Enter}Secondo');
    await phoneControls(canvasElement);
    await userEvent.selectOptions(language, 'en');
    await expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveValue('Corrected title');
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_terms_save() }));
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.catalogue_terms_stale());
    await expect(canvas.getByRole('button', { name: m.catalogue_terms_save() })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: m.catalogue_create_add_language() })).toBeDisabled();
    await phoneControls(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_terms_compare() }));
    expect(await canvas.findByText('Another editor’s title')).toBeVisible();
    await phoneControls(canvasElement);
    await userEvent.selectOptions(language, 'it');
    await expect(canvas.getByRole('textbox', { name: m.catalogue_create_aliases() })).toHaveValue('Primo\nSecondo');
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.catalogue_create_language() }), 'ja');
    expect(canvas.getAllByText('元の映画', { selector: 'span[lang="ja"]' })[0]).toBeVisible();
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.catalogue_create_language() }), 'en');
    expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveValue('Corrected title');
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_terms_confirm() }));
    expect(await canvas.findByText(m.catalogue_terms_saved())).toBeVisible();
    await expect(canvas.getByRole('link', { name: m.catalogue_create_open() })).toHaveAttribute(
      'href',
      expect.stringContaining(`/${getLocale()}/subjects/${termsSubjectId}/`),
    );
    await phoneControls(canvasElement);
  },
};
export const Denied: Story = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.catalogue_terms_denied());
    expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveValue('Corrected title');
  },
};
export const KeyConflict: Story = {
  args: { scenario: 'conflict' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.catalogue_terms_conflict());
    expect(canvas.getByRole('button', { name: m.catalogue_terms_save() })).toBeDisabled();
  },
};
export const UnavailableRetry: Story = {
  args: { scenario: 'read-unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.catalogue_retry_loading_result() }));
    expect(await canvas.findByRole('combobox', { name: m.catalogue_create_language() })).toBeVisible();
  },
};
export const UncertainRetry: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.catalogue_terms_uncertain());
    expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_retry() }));
    expect(await canvas.findByText(m.catalogue_terms_saved())).toBeVisible();
  },
};
export const ReaderDenied: Story = {
  args: { scenario: 'reader-denied' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByText(m.catalogue_result_read_denied())).toBeVisible();
    expect(canvas.getByText(m.catalogue_terms_saved())).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_retry_loading_result() }));
    expect(await canvas.findByText(m.catalogue_result_read_denied())).toBeVisible();
    expect(canvas.getByText(m.catalogue_terms_saved())).toBeVisible();
  },
};
