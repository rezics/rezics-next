import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useMemo } from 'react';
import { PublicationEditor } from '../features/catalogue/publication-editor-form';
import { publicationCreatedId, publicationFixture, type PublicationScenario } from '../kernel/fake/publication-editor';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

function PublicationStory({
  scenario = 'ready',
  workType = 'schema:Book',
  signedOut = false,
}: {
  scenario?: PublicationScenario;
  workType?: string;
  signedOut?: boolean;
}) {
  const locale = getLocale();
  const fixture = useMemo(() => publicationFixture(scenario, locale, workType), [scenario, locale, workType]);
  return (
    <PatternStory
      path={`/catalogue/publication?work=${fixture.work.subject.id}`}
      visitor={signedOut ? 'Signed Out' : 'Signed In'}
    >
      <AppShell>
        <PublicationEditor
          key={`${scenario}:${locale}:${workType}`}
          work={fixture.work.subject.id}
          locale={locale}
          session={signedOut ? 'signed-out' : 'signed-in'}
          transport={fixture.transport}
          search={async () => [
            {
              id: '00000000-0000-4000-8000-00000000e003',
              title: 'Example Press',
              types: ['schema:Organization'],
              typeLabel: 'Publisher',
              cover: null,
            },
          ]}
          onNavigate={() => {
            /* Keep the exact confirmed reader link available for review. */
          }}
        />
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Catalogue/Publication editor',
  component: PublicationStory,
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
          'Ordinary publication creation with an existing work, emitted profiles and native-shaped request examples. Native acceptance and Web/Root visual review remain pending.',
      },
    },
  },
} satisfies Meta<typeof PublicationStory>;
export default meta;
type Story = StoryObj<typeof meta>;

async function fill(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.type(await canvas.findByRole('textbox', { name: m.catalogue_create_label() }), 'A distinct edition');
  const language = canvas.getByRole('textbox', { name: m.catalogue_create_language() });
  await userEvent.clear(language);
  await userEvent.type(language, 'en');
  await userEvent.click(canvas.getByRole('checkbox', { name: m.publication_independent() }));
  await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.publication_field() }), 'schema:isbn');
  await userEvent.click(canvas.getByRole('button', { name: m.correction_add() }));
  await userEvent.type(canvas.getByRole('textbox', { name: m.correction_value() }), '978-0-140-44430-8');
  await userEvent.type(
    canvas.getByRole('textbox', { name: m.relation_citation() }),
    'https://publisher.example/edition',
  );
  return canvas;
}
async function submit(canvasElement: HTMLElement) {
  const canvas = await fill(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.publication_submit() }));
  return canvas;
}
export const Ready: Story = {};
export const Loading: Story = { args: { scenario: 'loading' } };
export const NoReleasedProfile: Story = { args: { scenario: 'empty' } };
export const SignedOut: Story = { args: { signedOut: true } };
export const WorkUnavailable: Story = { args: { scenario: 'concealed' } };
export const SuccessfulCreation: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('link', { name: m.catalogue_create_open() })).toHaveAttribute(
      'href',
      `/${getLocale()}/subjects/${publicationCreatedId}/a-distinct-edition`,
    );
    expect(canvas.queryByRole('button', { name: m.publication_submit() })).toBeNull();
  },
};
export const GrainRequired: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByRole('textbox', { name: m.catalogue_create_label() }), 'A file in French');
    await userEvent.click(canvas.getByRole('button', { name: m.publication_submit() }));
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.catalogue_create_invalid());
    expect(canvas.getByRole('checkbox', { name: m.publication_independent() })).toHaveAttribute('aria-invalid', 'true');
  },
};
export const AnthologyWorkLink: Story = {
  args: { workType: 'schema:Movie' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(await canvas.findByRole('combobox', { name: m.relation_property() }), 'bf:hasPart');
    expect(canvas.getByRole('combobox', { name: m.relation_property() })).toHaveValue('bf:hasPart');
  },
};
export const Denied: Story = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.catalogue_create_denied());
    expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveValue('A distinct edition');
  },
};
export const Invalid: Story = {
  args: { scenario: 'invalid' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.catalogue_create_invalid());
    expect(canvas.getByRole('textbox', { name: m.correction_value() })).toHaveValue('978-0-140-44430-8');
  },
};
export const Conflict: Story = {
  args: { scenario: 'conflict' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.catalogue_create_conflict());
    expect(canvas.getByRole('button', { name: m.publication_submit() })).toBeDisabled();
  },
};
export const UnavailableRetry: Story = {
  args: { scenario: 'unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.catalogue_create_retry() }));
    expect(await canvas.findByRole('textbox', { name: m.catalogue_create_label() })).toBeVisible();
  },
};
export const UncertainRetry: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.catalogue_create_uncertain());
    expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_retry() }));
    expect(await canvas.findByRole('link', { name: m.catalogue_create_open() })).toHaveAttribute(
      'href',
      `/${getLocale()}/subjects/${publicationCreatedId}/a-distinct-edition`,
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
  args: { scenario: 'reader-concealed' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByText(m.catalogue_create_concealed())).toBeVisible();
    expect(canvas.queryByRole('link', { name: m.catalogue_create_open() })).toBeNull();
  },
};
