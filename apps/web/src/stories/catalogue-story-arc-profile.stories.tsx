import type { Meta, StoryObj } from '@storybook/react-vite';
import { pickText } from '@rezics/composition';
import { useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { StoryArcProfile } from '../features/catalogue/story-arc-profile-view';
import { storyArcProperty } from '../features/catalogue/story-arc-profile';
import {
  storyArcProfileFixture,
  storyArcProfileId,
  storyArcCreatedId,
  type StoryArcScenario,
} from '../kernel/fake/catalogue-story-arc-profile';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PageStory, PatternStory } from './page';

function Example({
  scenario = 'ready',
  existing = false,
  work = false,
}: {
  scenario?: StoryArcScenario;
  existing?: boolean;
  work?: boolean;
}) {
  const locale = getLocale();
  const fixture = useMemo(() => storyArcProfileFixture(scenario, locale), [scenario, locale]);
  return (
    <PatternStory visitor={scenario === 'signed-out' ? 'Signed Out' : 'Signed In'}>
      <AppShell>
        <StoryArcProfile
          key={`${scenario}:${existing}:${work}:${locale}`}
          locale={locale}
          {...fixture.props}
          {...(existing ? { id: storyArcProfileId } : {})}
          {...(work ? { work: fixture.work.id } : {})}
        />
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Catalogue/Narrative story-arc editor',
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
          'Create an arc under one task heading with read-only released Type metadata, or choose an existing arc. Synthetic native-shaped responses use production creation, scalar and relation adapters. Review the same outcome states at phone390 and desktop1280 with locale, theme and viewport globals. Web visual review and integrated native bindings remain pending.',
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

export const RouteEntry: Story = { render: () => <PageStory visitor="Signed In" path="/catalogue/story-arc" /> };
export const Create: Story = {};
export const CurrentArc: Story = { args: { existing: true } };
export const WorkOrder: Story = {
  args: { existing: true, work: true },
  play: async ({ canvasElement }) => {
    await reviewSlot(canvasElement);
  },
};

async function create(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.type(await canvas.findByRole('textbox', { name: m.catalogue_create_label() }), 'A real arc');
  await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
  return canvas;
}
export const Created: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await create(canvasElement);
    const link = await canvas.findByRole('link', { name: m.catalogue_create_open() });
    expect(link.getAttribute('href')).toContain(`/subjects/${storyArcCreatedId}/a-real-arc`);
    await expect(canvas.findByRole('link', { name: m.story_arc_continue() })).resolves.toBeVisible();
  },
};
export const UncertainRetry: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = await create(canvasElement);
    const retry = await canvas.findByRole('button', { name: m.catalogue_create_retry() });
    expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toBeDisabled();
    await userEvent.click(retry);
    await expect(canvas.findByRole('link', { name: m.story_arc_continue() })).resolves.toBeVisible();
  },
};

async function editKeywords(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const name = pickText(storyArcProfileFixture().release.properties['schema:keywords']!.labels, getLocale()).text;
  const field = within(await canvas.findByRole('region', { name }));
  await userEvent.click(field.getByRole('button', { name: m.facts_edit_field() }));
  const value = field.getByRole('textbox', { name: m.correction_value() });
  await userEvent.clear(value);
  await userEvent.type(value, 'A corrected theme');
  return { canvas, field };
}
export const Proposed: Story = {
  args: { existing: true },
  play: async ({ canvasElement }) => {
    const { canvas, field } = await editKeywords(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.facts_submit() }));
    await expect(field.findByText(m.correction_proposed())).resolves.toBeVisible();
    expect(field.getByRole('link', { name: m.correction_review() }).getAttribute('href')).toContain('candidate=');
  },
};
export const PartialResults: Story = {
  args: { scenario: 'partial', existing: true },
  play: async ({ canvasElement }) => {
    const { canvas, field } = await editKeywords(canvasElement);
    const name = pickText(storyArcProfileFixture().release.properties['schema:url']!.labels, getLocale()).text;
    const url = within(canvas.getByRole('region', { name }));
    await userEvent.click(url.getByRole('button', { name: m.facts_edit_field() }));
    await userEvent.type(url.getByRole('textbox', { name: m.correction_value() }), 'https://example.org/arc');
    await userEvent.click(canvas.getByRole('button', { name: m.facts_submit() }));
    await expect(field.findByText(m.correction_proposed())).resolves.toBeVisible();
    await expect(url.findByText(m.correction_denied())).resolves.toBeVisible();
  },
};

async function reviewSlot(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const work = within(await canvas.findByRole('region', { name: m.story_arc_work() }));
  await userEvent.click(work.getByRole('button', { name: m.relation_open() }));
  await userEvent.selectOptions(await work.findByRole('combobox', { name: m.relation_property() }), storyArcProperty);
  await userEvent.click(work.getAllByRole('button', { name: m.relation_edit_existing() })[0]!);
  await userEvent.click(work.getByRole('button', { name: m.relation_review_slot() }));
  await expect(work.findByRole('button', { name: m.candidate_review() })).resolves.toBeVisible();
  return work;
}
async function confirm(work: ReturnType<typeof within>, action: string) {
  await userEvent.click(work.getByRole('button', { name: action }));
  const group = within(work.getByRole('group', { name: m.candidate_confirm_title({ action }) }));
  await userEvent.click(group.getByRole('button', { name: action }));
}
async function adopt(canvasElement: HTMLElement) {
  const work = await reviewSlot(canvasElement);
  await userEvent.click(work.getByRole('button', { name: m.candidate_review() }));
  await confirm(work, m.candidate_accept());
  await expect(work.findByText(m.candidate_accepted())).resolves.toBeVisible();
  await userEvent.click(work.getByRole('button', { name: m.candidate_reload() }));
  await userEvent.click(await work.findByRole('button', { name: m.candidate_review() }));
  await userEvent.selectOptions(work.getByRole('combobox', { name: m.relation_rank() }), 'preferred');
  await confirm(work, m.candidate_adopt());
  return work;
}
export const Selected: Story = {
  args: { existing: true, work: true },
  play: async ({ canvasElement }) => {
    const work = await adopt(canvasElement);
    await expect(work.findByText(m.candidate_selected())).resolves.toBeVisible();
  },
};
export const PendingSelection: Story = {
  args: { scenario: 'pending', existing: true, work: true },
  play: async ({ canvasElement }) => {
    const work = await adopt(canvasElement);
    await expect(work.findByText(m.candidate_pending())).resolves.toBeVisible();
  },
};
export const Invalid: Story = {
  args: { scenario: 'invalid' },
  play: async ({ canvasElement }) => {
    await create(canvasElement);
  },
};
export const Conflict: Story = {
  args: { scenario: 'conflict' },
  play: async ({ canvasElement }) => {
    await create(canvasElement);
  },
};
export const Saving: Story = {
  args: { scenario: 'saving' },
  play: async ({ canvasElement }) => {
    await create(canvasElement);
  },
};
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
export const Loading: Story = { args: { scenario: 'loading' } };
export const SignedOut: Story = { args: { scenario: 'signed-out', existing: true } };
export const Denied: Story = { args: { scenario: 'denied', existing: true } };
export const Unavailable: Story = { args: { scenario: 'unavailable' } };
export const StaleMetadata: Story = { args: { scenario: 'stale' } };
export const WrongGrain: Story = { args: { scenario: 'wrong-type', existing: true } };
