import type { Meta, StoryObj } from '@storybook/react-vite';
import { pickText } from '@rezics/composition';
import { useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { CharacterProfile } from '../features/catalogue/character-profile-view';
import {
  characterProfileFixture,
  characterProfileId,
  characterCreatedId,
  type CharacterScenario,
} from '../kernel/fake/catalogue-character-profile';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PageStory, PatternStory } from './page';
import {
  createObserver,
  recoverLanguageRow,
  retryLanguageRecovery,
  type ObserveCreate,
} from './catalogue-language-row-recovery';

function Example({
  scenario = 'ready',
  existing = false,
  work = false,
  onCreate,
}: {
  scenario?: CharacterScenario;
  existing?: boolean;
  work?: boolean;
  onCreate?: ObserveCreate;
}) {
  const locale = getLocale();
  const fixture = useMemo(() => characterProfileFixture(scenario, locale), [scenario, locale]);
  const transport = useMemo(
    () => ({
      ...fixture.transport,
      create: async (command: Parameters<typeof fixture.transport.create>[0]) => {
        const result = await fixture.transport.create(command);
        onCreate?.(structuredClone(fixture.calls));
        return result;
      },
    }),
    [fixture, onCreate],
  );
  return (
    <PatternStory visitor={scenario === 'signed-out' ? 'Signed Out' : 'Signed In'}>
      <AppShell>
        <CharacterProfile
          key={`${scenario}:${existing}:${work}:${locale}`}
          locale={locale}
          {...fixture.props}
          transport={transport}
          {...(existing ? { id: characterProfileId } : {})}
          {...(work ? { work: fixture.work.id } : {})}
        />
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Catalogue/Character identity and credit editor',
  component: Example,
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
          'Native-shaped synthetic responses through the production adapters. Use locale, theme and viewport globals. Visual review and native binding evidence are still owned by Web and integration.',
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

export const RouteEntry: Story = { render: () => <PageStory visitor="Signed In" path="/catalogue/character" /> };
export const Create: Story = {};
export const LanguageRowRecovery: Story = {
  args: { scenario: 'uncertain', onCreate: createObserver() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByRole('textbox', { name: m.catalogue_create_label() }), 'A new traveler');
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.character_initial_fact() }), 'schema:url');
    await userEvent.click(canvas.getByRole('button', { name: m.character_add_fact() }));
    await userEvent.type(canvas.getByRole('textbox', { name: m.correction_value() }), 'https://example.org/traveler');
    const observed = args.onCreate as ReturnType<typeof createObserver>;
    const terms = await recoverLanguageRow(
      canvasElement,
      m.character_create(),
      observed,
      'A new traveler',
      '新しい旅人',
    );
    await retryLanguageRecovery(canvasElement, m.character_create(), m.correction_retry(), observed, {
      type: 'wd:Q95074',
      ...terms,
      statements: {
        'schema:url': [
          {
            property: { id: 'schema:url' },
            value: { type: 'value', content: 'https://example.org/traveler' },
            qualifiers: [],
            references: [],
            rank: 'normal',
          },
        ],
      },
    });
    await expect(await canvas.findByRole('link', { name: m.character_correct() })).toBeVisible();
  },
};
export const CurrentIdentity: Story = { args: { existing: true } };
export const WorkCredits: Story = {
  args: { existing: true, work: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.relation_open() }));
    await userEvent.selectOptions(await canvas.findByRole('combobox', { name: m.relation_property() }), 'wdt:P725');
    await userEvent.click(canvas.getAllByRole('button', { name: m.relation_edit_existing() })[0]!);
    await userEvent.click(canvas.getByRole('button', { name: m.relation_review_slot() }));
    await expect(canvas.findByRole('button', { name: m.candidate_review() })).resolves.toBeVisible();
  },
};
async function create(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.type(await canvas.findByRole('textbox', { name: m.catalogue_create_label() }), 'A new traveler');
  await userEvent.click(canvas.getByRole('button', { name: m.character_create() }));
  return canvas;
}
export const Created: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await create(canvasElement);
    const link = await canvas.findByRole('link', { name: m.candidate_view_public() });
    expect(link.getAttribute('href')).toContain(`/subjects/${characterCreatedId}/a-new-traveler`);
    await expect(canvas.findByRole('link', { name: m.character_correct() })).resolves.toBeVisible();
  },
};
export const UncertainRetry: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = await create(canvasElement);
    const retry = await canvas.findByRole('button', { name: m.correction_retry() });
    expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toBeDisabled();
    await userEvent.click(retry);
    await expect(canvas.findByRole('link', { name: m.character_correct() })).resolves.toBeVisible();
  },
};
export const Proposed: Story = {
  args: { existing: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const quantity = await canvas.findByRole('region', {
      name: pickText(characterProfileFixture().release.properties['schema:height']!.labels, getLocale()).text,
    });
    const field = within(quantity);
    await userEvent.click(field.getByRole('button', { name: m.facts_edit_field() }));
    const amount = field.getByRole('textbox', { name: m.correction_amount() });
    await userEvent.clear(amount);
    await userEvent.type(amount, '+171');
    await userEvent.click(canvas.getByRole('button', { name: m.facts_submit() }));
    await expect(field.findByText(m.correction_proposed())).resolves.toBeVisible();
    expect(field.getByRole('link', { name: m.correction_review() }).getAttribute('href')).toContain('candidate=');
  },
};
export const Invalid: Story = {
  args: { scenario: 'invalid' },
  play: async ({ canvasElement }) => {
    await create(canvasElement);
  },
};
export const Loading: Story = { args: { scenario: 'loading' } };
export const SignedOut: Story = { args: { scenario: 'signed-out', existing: true } };
export const Denied: Story = { args: { scenario: 'denied', existing: true } };
export const Unavailable: Story = { args: { scenario: 'unavailable' } };
export const StaleMetadata: Story = { args: { scenario: 'stale' } };
export const ReaderUnavailable: Story = {
  args: { scenario: 'reader-unavailable' },
  play: async ({ canvasElement }) => {
    await create(canvasElement);
  },
};
export const ConcealedReader: Story = {
  args: { scenario: 'concealed' },
  play: async ({ canvasElement }) => {
    await create(canvasElement);
  },
};
export const PendingSelection: Story = { args: { scenario: 'pending', existing: true, work: true } };
