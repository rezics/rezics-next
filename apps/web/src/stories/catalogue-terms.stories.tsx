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
    expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveAccessibleDescription(
      m.catalogue_terms_validation_name(),
    );
    expect(canvas.getByText(m.catalogue_terms_validation_name())).toBeVisible();
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
    await userEvent.selectOptions(
      within(canvas.getByRole('group', { name: `en: ${m.catalogue_create_label()}` })).getByRole('combobox', {
        name: m.catalogue_terms_resolve_choice(),
      }),
      'draft',
    );
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_terms_review() }));
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
    expect(canvas.getByRole('button', { name: m.catalogue_terms_discard_language({ language: 'en' }) })).toBeDisabled();
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

export const TwoEditedLanguages: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await fill(canvasElement);
    const language = canvas.getByRole('combobox', { name: m.catalogue_create_language() });
    await userEvent.selectOptions(language, 'ja');
    await userEvent.selectOptions(
      within(canvas.getByRole('group', { name: m.catalogue_create_description() })).getByRole('combobox'),
      'remove',
    );
    const summary = within(canvas.getByRole('region', { name: m.catalogue_terms_unsaved_languages() }));
    await expect(summary.getByRole('button', { name: `en: ${m.catalogue_create_label()}` })).toBeVisible();
    await expect(summary.getByRole('button', { name: `ja: ${m.catalogue_create_description()}` })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(summary.getByRole('button', { name: `en: ${m.catalogue_create_label()}` }));
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_terms_discard_language({ language: 'en' }) }));
    await expect(summary.queryByRole('button', { name: `en: ${m.catalogue_create_label()}` })).toBeNull();
    await expect(summary.getByRole('button', { name: `ja: ${m.catalogue_create_description()}` })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: m.catalogue_create_remove_language() })).toBeNull();
    await userEvent.type(canvas.getByRole('textbox', { name: m.catalogue_terms_new_language() }), 'it');
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_add_language() }));
    await userEvent.selectOptions(language, 'ja');
    await userEvent.selectOptions(language, 'it');
    await userEvent.selectOptions(
      within(canvas.getByRole('group', { name: m.catalogue_create_aliases() })).getByRole('combobox'),
      'set',
    );
    await userEvent.type(canvas.getByRole('textbox', { name: m.catalogue_create_aliases() }), 'Primo');
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_terms_discard_language({ language: 'it' }) }));
    await expect(summary.queryByRole('button', { name: `it: ${m.catalogue_create_aliases()}` })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_remove_language() }));
    await expect(canvas.queryByRole('option', { name: 'it' })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_terms_save() }));
    await expect(canvas.findByText(m.catalogue_terms_saved())).resolves.toBeVisible();
    await expect(canvas.getByText('Original film')).toBeVisible();
    await expect(canvas.getByText('元の映画')).toBeVisible();
    await expect(canvas.queryByText('元の説明')).toBeNull();
  },
};

export const UncertainDraftRevision: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = await fill(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: m.catalogue_terms_new_language() }), 'it');
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_add_language() }));
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_terms_save() }));
    await expect(canvas.findByRole('alert')).resolves.toHaveTextContent(m.catalogue_terms_uncertain());
    await expect(canvas.getByRole('button', { name: m.catalogue_create_remove_language() })).toBeDisabled();
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.catalogue_create_language() }), 'en');
    await expect(
      canvas.getByRole('button', { name: m.catalogue_terms_discard_language({ language: 'en' }) }),
    ).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_retry() }));
    await expect(canvas.findByText(m.catalogue_terms_saved())).resolves.toBeVisible();
    await expect(canvas.getByText('Corrected title')).toBeVisible();
  },
};

// Additive mounted examples; all original scenarios and plays above remain canonical.
function IndependentTermsStory() {
  const locale = getLocale();
  const fixtures = useMemo(() => {
    const first = catalogueTermsFixture('ready', locale);
    first.subject.labels.en = `A supplied name ${'星'.repeat(225)}`;
    first.subject.descriptions.en = 'A long description that remains available while the draft is edited. '.repeat(3);
    first.subject.aliases.en = [`LongAlias${'x'.repeat(230)}`, 'Second alias', '第三の別名'];
    return [first, catalogueTermsFixture('ready', locale)] as const;
  }, [locale]);
  return (
    <PatternStory path={`/subjects/${termsSubjectId}/original-film/terms`} visitor="Signed In">
      <AppShell>
        <div className="flex min-w-0 flex-col gap-12">
          {fixtures.map((fixture, index) => (
            <SubjectTermsPage
              key={`${index}:${locale}`}
              id={termsSubjectId}
              locale={locale}
              session="signed-in"
              transport={fixture.transport}
              {...(index === 0
                ? { typeLabels: { 'schema:Movie': `Movie / ${'supplied-type-reference:'.repeat(12)}` } }
                : {})}
            />
          ))}
        </div>
      </AppShell>
    </PatternStory>
  );
}

function independentArticles(canvasElement: HTMLElement) {
  const articles = [...canvasElement.querySelectorAll<HTMLElement>('article')];
  expect(articles).toHaveLength(2);
  const ids = [...canvasElement.querySelectorAll('[id]')].map((element) => element.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const article of articles) {
    for (const label of article.querySelectorAll('label')) {
      expect(article.contains(document.getElementById(label.htmlFor))).toBe(true);
    }
    for (const control of article.querySelectorAll('[aria-describedby]')) {
      for (const id of control.getAttribute('aria-describedby')!.split(' ').filter(Boolean)) {
        expect(article.contains(document.getElementById(id))).toBe(true);
      }
    }
  }
  return articles as [HTMLElement, HTMLElement];
}

export const IndependentForms: Story = {
  render: () => <IndependentTermsStory />,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findAllByRole('combobox', { name: m.catalogue_create_language() });
    const [left, right] = independentArticles(canvasElement);
    const a = await fill(left, 'First independent draft');
    const b = await fill(right, 'Second independent draft');
    await userEvent.type(a.getByRole('textbox', { name: m.catalogue_terms_new_language() }), 'it');
    await userEvent.click(a.getByRole('button', { name: m.catalogue_create_add_language() }));
    await expect(b.getByRole('combobox', { name: m.catalogue_create_language() })).toHaveValue('en');
    await expect(b.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveValue('Second independent draft');
    const aliases = within(a.getByRole('group', { name: m.catalogue_create_aliases() }));
    await userEvent.selectOptions(aliases.getByRole('combobox'), 'set');
    await userEvent.type(aliases.getByRole('textbox'), 'Primo{Enter}Secondo');
    await expect(aliases.getByRole('textbox')).toHaveAccessibleDescription(m.catalogue_terms_alias_limits());
    await userEvent.selectOptions(a.getByRole('combobox', { name: m.catalogue_create_language() }), 'en');
    await expect(a.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveValue('First independent draft');
    independentArticles(canvasElement);
    await userEvent.click(a.getByRole('button', { name: m.catalogue_terms_save() }));
    await expect(await a.findByText(m.catalogue_terms_saved())).toBeVisible();
    await expect(b.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveValue('Second independent draft');
    await expect(b.getByRole('button', { name: m.catalogue_terms_save() })).toBeEnabled();
  },
};

export const LongTextPhone: Story = {
  render: () => <IndependentTermsStory />,
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    const languages = await within(canvasElement).findAllByRole('combobox', { name: m.catalogue_create_language() });
    const [left] = independentArticles(canvasElement);
    const canvas = within(left);
    await userEvent.selectOptions(languages[0]!, 'en');
    for (const name of [m.catalogue_create_label(), m.catalogue_create_description(), m.catalogue_create_aliases()]) {
      await userEvent.selectOptions(within(canvas.getByRole('group', { name })).getByRole('combobox'), 'set');
    }
    await expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveValue(
      `A supplied name ${'星'.repeat(225)}`,
    );
    await expect(canvas.getByRole('textbox', { name: m.catalogue_create_aliases() })).toHaveValue(
      `LongAlias${'x'.repeat(230)}\nSecond alias\n第三の別名`,
    );
    await phoneControls(canvasElement);
    for (const content of left.querySelectorAll<HTMLElement>('h1, h2, legend, dd, textarea')) {
      await expect(content.scrollWidth).toBeLessThanOrEqual(content.clientWidth);
    }
    for (const original of canvas.getAllByText(m.catalogue_terms_original(), { exact: true }))
      await expect(original).toBeVisible();
  },
};

export const KeyboardLabelAndErrorAssociations: Story = {
  render: () => <IndependentTermsStory />,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findAllByRole('combobox', { name: m.catalogue_create_language() });
    const [left, right] = independentArticles(canvasElement);
    const a = await fill(left, '');
    const b = await fill(right, 'Independent value');
    await userEvent.click(a.getByRole('button', { name: m.catalogue_terms_save() }));
    const input = a.getByRole('textbox', { name: m.catalogue_create_label() });
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(input).toHaveAccessibleDescription(m.catalogue_terms_validation_name());
    await expect(b.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveAttribute('aria-invalid', 'false');
    const inputLabel = [...left.querySelectorAll('label')].find((label) => label.htmlFor === input.id)!;
    await userEvent.click(inputLabel);
    await expect(input).toHaveFocus();
    await expect(getComputedStyle(input).boxShadow).not.toBe('none');
    const language = a.getByRole('combobox', { name: m.catalogue_create_language() });
    language.focus();
    await userEvent.tab();
    const newLanguage = a.getByRole('textbox', { name: m.catalogue_terms_new_language() });
    await expect(newLanguage).toHaveFocus();
    await userEvent.type(newLanguage, 'english!');
    await userEvent.tab();
    await expect(a.getByRole('button', { name: m.catalogue_create_add_language() })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(newLanguage).toHaveAccessibleDescription(m.catalogue_terms_validation_language());
    await expect(b.queryByText(m.catalogue_terms_validation_language())).toBeNull();
    independentArticles(canvasElement);
    await userEvent.click([...left.querySelectorAll('label')].find((label) => label.htmlFor === newLanguage.id)!);
    await expect(newLanguage).toHaveFocus();
    await userEvent.clear(newLanguage);
    await userEvent.type(newLanguage, 'it');
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    await expect(language).toHaveValue('it');
    await expect(b.getByRole('combobox', { name: m.catalogue_create_language() })).toHaveValue('en');
    await userEvent.selectOptions(language, 'en');
    await expect(a.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveValue('');
    independentArticles(canvasElement);
  },
};
