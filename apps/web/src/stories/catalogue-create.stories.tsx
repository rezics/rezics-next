import type { Meta, StoryObj } from '@storybook/react-vite';
import { pickText } from '@rezics/composition';
import { expect, userEvent, within } from 'storybook/test';
import { useMemo } from 'react';
import { CreateSubjectForm } from '../features/catalogue/create-subject-form';
import { catalogueCreateFixture, catalogueCreatedId, type CreateScenario } from '../kernel/fake/catalogue-create';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { subjectHref } from '../subject/subject-href';
import { PatternStory } from './page';

function CreateStory({ scenario = 'ready' }: { scenario?: CreateScenario }) {
  const locale = getLocale();
  const fixture = useMemo(() => catalogueCreateFixture(scenario, locale), [scenario, locale]);
  return (
    <PatternStory path="/catalogue/new" visitor={scenario === 'signed-out' ? 'Signed Out' : 'Signed In'}>
      <AppShell>
        <CreateSubjectForm
          key={`${scenario}:${locale}`}
          locale={locale}
          session={scenario === 'signed-out' ? 'signed-out' : 'signed-in'}
          transport={fixture.transport}
          onNavigate={() => {
            /* Keep the confirmed ordinary-reader link reviewable in this story. */
          }}
        />
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Catalogue/Create subject',
  component: CreateStory,
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
          'Start with Name and data language, search for duplicates in a new tab, then choose the released Type. Other catalogue editors are available after the form. Review these same states with the phone390 and desktop1280 viewport globals; these fixtures do not establish native API or visual acceptance.',
      },
    },
  },
} satisfies Meta<typeof CreateStory>;
export default meta;
type Story = StoryObj<typeof meta>;

async function fill(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.selectOptions(
    await canvas.findByRole('combobox', { name: m.catalogue_create_type() }),
    'schema:Movie',
  );
  const language = canvas.getByRole('textbox', { name: m.catalogue_create_language() });
  await userEvent.clear(language);
  await userEvent.type(language, 'en');
  await userEvent.type(canvas.getByRole('textbox', { name: m.catalogue_create_label() }), 'A new film');
  await userEvent.type(canvas.getByRole('textbox', { name: m.catalogue_create_description() }), 'An independent film');
  await userEvent.type(canvas.getByRole('textbox', { name: m.catalogue_create_aliases() }), 'Working title');
  return canvas;
}
async function submit(canvasElement: HTMLElement) {
  const canvas = await fill(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
  return canvas;
}

export const Ready: Story = {};
export const CreateMultilingualSubject: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await fill(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_add_language() }));
    await userEvent.type(canvas.getAllByRole('textbox', { name: m.catalogue_create_language() })[1]!, 'ja');
    await userEvent.type(canvas.getAllByRole('textbox', { name: m.catalogue_create_label() })[1]!, '新しい映画');
    await userEvent.dblClick(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
    const link = await canvas.findByRole('link', { name: m.catalogue_create_open() });
    expect(link.getAttribute('href')).toBe(
      subjectHref(
        { id: catalogueCreatedId, label: pickText({ en: 'A new film', ja: '新しい映画' }, getLocale()).text },
        getLocale(),
      ).href,
    );
    expect(canvas.queryByRole('button', { name: m.catalogue_create_submit() })).toBeNull();
  },
};
export const Loading: Story = { args: { scenario: 'loading' } };
export const NoReleasedTypes: Story = { args: { scenario: 'empty' } };
export const SignedOut: Story = { args: { scenario: 'signed-out' } };
export const Denied: Story = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.catalogue_create_denied());
    expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveValue('A new film');
  },
};
export const InvalidFields: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const type = await canvas.findByRole('combobox', { name: m.catalogue_create_type() });
    const name = canvas.getByRole('textbox', { name: m.catalogue_create_label() });
    const language = canvas.getByRole('textbox', { name: m.catalogue_create_language() });
    const create = canvas.getByRole('button', { name: m.catalogue_create_submit() });
    await step('Generic Subject creation explains and associates actual invalid fields', async () => {
      await userEvent.clear(language);
      await userEvent.type(language, 'en');
      await userEvent.type(name, '   ');
      await userEvent.click(create);
      expect(await canvas.findByText(m.catalogue_create_invalid())).toBeVisible();
      expect(canvas.getByText(m.catalogue_create_validation_type_required())).toHaveAttribute(
        'id',
        'create-type-error',
      );
      expect(canvas.getByText(m.catalogue_create_validation_name_required())).toHaveAttribute(
        'id',
        'create-label-0-error',
      );
      expect(type).toHaveAttribute('aria-invalid', 'true');
      expect(type).toHaveAttribute('aria-describedby', 'create-grain create-type-help create-type-error');
      expect(name).toHaveAttribute('aria-invalid', 'true');
      expect(name).toHaveAttribute('aria-describedby', 'create-label-0-help create-label-0-error');

      await userEvent.clear(name);
      await userEvent.type(name, ' A new film ');
      expect(canvas.queryByText(m.catalogue_create_validation_name_required())).toBeNull();
      expect(name).toHaveAttribute('aria-invalid', 'false');
      expect(name).toHaveAttribute('aria-describedby', 'create-label-0-help');
      expect(type).toHaveAttribute('aria-describedby', 'create-grain create-type-help');

      await userEvent.clear(language);
      await userEvent.type(language, 'en_US');
      await userEvent.click(create);
      expect(await canvas.findByText(m.catalogue_create_validation_language())).toHaveAttribute(
        'id',
        'create-language-0-error',
      );
      expect(language).toHaveAttribute('aria-invalid', 'true');
      expect(language).toHaveAttribute('aria-describedby', 'create-language-0-help create-language-0-error');
      expect(name).toHaveAttribute('aria-invalid', 'false');
      await userEvent.clear(language);
      await userEvent.type(language, ' en ');
      expect(canvas.queryByText(m.catalogue_create_validation_language())).toBeNull();
      expect(language).toHaveAttribute('aria-invalid', 'false');
      expect(language).toHaveAttribute('aria-describedby', 'create-language-0-help');

      await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_add_language() }));
      const secondLanguage = canvas.getAllByRole('textbox', { name: m.catalogue_create_language() })[1]!;
      const secondName = canvas.getAllByRole('textbox', { name: m.catalogue_create_label() })[1]!;
      await userEvent.type(secondLanguage, 'en');
      await userEvent.type(secondName, 'Another name');
      await userEvent.click(create);
      expect(await canvas.findByText(m.catalogue_create_validation_language_unique())).toHaveAttribute(
        'id',
        'create-language-1-error',
      );
      expect(secondLanguage).toHaveAttribute('aria-invalid', 'true');
      expect(secondLanguage).toHaveAttribute('aria-describedby', 'create-language-1-help create-language-1-error');
      expect(secondName).toHaveAttribute('aria-invalid', 'false');
      await userEvent.clear(secondLanguage);
      await userEvent.type(secondLanguage, 'ja');
      expect(canvas.queryByText(m.catalogue_create_validation_language_unique())).toBeNull();
      expect(secondLanguage).toHaveAttribute('aria-invalid', 'false');
      expect(secondLanguage).toHaveAttribute('aria-describedby', 'create-language-1-help');

      const aliases = canvas.getAllByRole('textbox', { name: m.catalogue_create_aliases() })[0]!;
      await userEvent.type(aliases, 'x'.repeat(251));
      await userEvent.click(create);
      expect(await canvas.findByText(m.catalogue_create_validation_alias_length())).toHaveAttribute(
        'id',
        'create-aliases-0-error',
      );
      expect(aliases).toHaveAttribute('aria-describedby', 'create-aliases-0-help create-aliases-0-error');
      await userEvent.clear(aliases);
      await userEvent.type(aliases, Array.from({ length: 33 }, (_, index) => `Alias ${index}`).join('\n'));
      await userEvent.click(create);
      expect(await canvas.findByText(m.catalogue_create_validation_alias_count())).toBeVisible();
      await userEvent.clear(aliases);
      await userEvent.type(aliases, 'Working title\n Working title ');
      await userEvent.click(create);
      expect(await canvas.findByText(m.catalogue_create_validation_alias_unique())).toBeVisible();
      await userEvent.clear(aliases);
      await userEvent.type(aliases, ' Working title \n\n');
      expect(canvas.queryByText(m.catalogue_create_validation_alias_unique())).toBeNull();
      expect(aliases).toHaveAttribute('aria-describedby', 'create-aliases-0-help');
      await userEvent.click(create);
      expect(canvas.getByText(m.catalogue_create_validation_type_required())).toBeVisible();
      expect(name).toHaveAttribute('aria-invalid', 'false');
      expect(language).toHaveAttribute('aria-invalid', 'false');
      expect(secondLanguage).toHaveAttribute('aria-invalid', 'false');
      expect(aliases).toHaveAttribute('aria-invalid', 'false');
      expect(canvas.queryByText(m.catalogue_create_created())).toBeNull();
      expect(canvas.queryByRole('link', { name: m.catalogue_create_open() })).toBeNull();

      // Leave the canonical story invalid, with both distinct required-field corrections visible.
      await userEvent.click(canvas.getAllByRole('button', { name: m.catalogue_create_remove_language() })[1]!);
      await userEvent.clear(name);
      await userEvent.click(create);
      expect(canvas.getByText(m.catalogue_create_validation_name_required())).toBeVisible();
      expect(canvas.getByText(m.catalogue_create_validation_type_required())).toBeVisible();
      expect(create).toBeEnabled();
    });
  },
};
export const RejectedValuesRefreshTypes: Story = {
  args: { scenario: 'invalid' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.catalogue_create_refresh());
    expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveAttribute('aria-invalid', 'true');
  },
};
export const Conflict: Story = {
  args: { scenario: 'conflict' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.catalogue_create_conflict());
    expect(canvas.getByRole('button', { name: m.catalogue_create_submit() })).toBeDisabled();
  },
};
export const UnavailableRetry: Story = {
  args: { scenario: 'definitions-unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.catalogue_create_retry() }));
    expect(await canvas.findByRole('combobox', { name: m.catalogue_create_type() })).toBeVisible();
  },
};
export const UncertainSubmitRetry: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.catalogue_create_uncertain());
    expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_retry() }));
    expect(await canvas.findByRole('link', { name: m.catalogue_create_open() })).toHaveAttribute(
      'href',
      `/${getLocale()}/subjects/${catalogueCreatedId}/a-new-film`,
    );
  },
};
export const Saving: Story = {
  args: { scenario: 'saving' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('button', { name: m.catalogue_create_saving() })).toBeDisabled();
  },
};
export const CreatedReaderUnavailable: Story = {
  args: { scenario: 'reader-unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByText(m.catalogue_create_reader_unavailable())).toBeVisible();
    expect(canvas.queryByRole('link', { name: m.catalogue_create_open() })).toBeNull();
  },
};
export const CreatedReaderConcealed: Story = {
  args: { scenario: 'concealed' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByText(m.catalogue_create_concealed())).toBeVisible();
    expect(canvas.queryByRole('link', { name: m.catalogue_create_open() })).toBeNull();
  },
};
