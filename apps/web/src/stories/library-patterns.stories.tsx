import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Button } from '@rezics/ui/shadcn/button';
import { CoverCard, CoverGrid } from '@rezics/ui/cover-card';
import { ShelfListRow } from '@rezics/ui/shelf-list';
import { ShelfTable, type ShelfColumn, type ShelfTableRow } from '@rezics/ui/shelf-table';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import definitions from '../kernel/recorded/definitions-release.json';
import { libraryStateOptions } from '../library/profiles';
import type { Release } from '../subject/definitions';
import { PatternStory } from './page';

const meta = { title: 'Patterns/Library/Tracked entries', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const recordedRelease = definitions.release as unknown as Release;

function stateExamples() {
  return libraryStateOptions(recordedRelease, 'schema:Book', getLocale()).map(({ id, label }) => ({
    id,
    label: label.text,
  }));
}

const samples = Array.from({ length: 3 }, (_, index) => {
  const title = ['Kokoro', 'The Little Prince', 'Norwegian Wood'][index]!;
  const id = `0192f3a0-6c1e-7b2a-9d4e-${String(index + 1).padStart(12, '0')}`;
  const subject = { id, title, types: ['schema:Book'] };
  const cover = { subject, cover: null, src: coverSrc };
  return { title, id, cover, subject };
});

function Grid({ size }: { size: 'small' | 'medium' | 'large' }) {
  return (
    <CoverGrid ratio="5:7" density={size} fixedDensity>
      {samples.map((sample) => (
        <CoverCard key={sample.id} title={sample.title} cover={sample.cover} />
      ))}
    </CoverGrid>
  );
}

function TrackedLayoutsPattern() {
  const row = samples[0]!;
  const states = stateExamples();
  const columns: ShelfColumn[] = [
    { id: 'cover', label: '', visible: true },
    { id: 'title', label: 'Title', visible: true },
    { id: 'status', label: 'Status', visible: true },
  ];
  const tableRows: ShelfTableRow[] = samples.map((sample, index) => ({
    id: sample.id,
    title: sample.title,
    href: `/en/subjects/${sample.id}`,
    cover: sample.cover,
    status: <a href={`/en/library?state=${states[index]!.id}`}>{states[index]!.label}</a>,
  }));
  return (
    <div className="space-y-8">
      <section aria-labelledby="grid-layout">
        <h2 id="grid-layout" className="mb-3 text-lg font-semibold">
          {m.library_layout_grid()}
        </h2>
        <Grid size="medium" />
      </section>
      <section aria-labelledby="list-layout">
        <h2 id="list-layout" className="mb-3 text-lg font-semibold">
          {m.library_layout_list()}
        </h2>
        <ul>
          {samples.map((sample, index) => (
            <ShelfListRow
              key={sample.id}
              href={`/en/subjects/${sample.id}`}
              title={sample.title}
              cover={sample.cover}
              status={<a href={`/en/library?state=${states[index]!.id}`}>{states[index]!.label}</a>}
              labels={{ select: `Select ${sample.title}`, menu: `Actions for ${sample.title}` }}
            />
          ))}
        </ul>
      </section>
      <section aria-labelledby="table-layout">
        <h2 id="table-layout" className="mb-3 text-lg font-semibold">
          {m.library_layout_table()}
        </h2>
        <ShelfTable rows={tableRows} columns={columns} onSort={() => {}} />
      </section>
      <p className="sr-only">{row.title}</p>
    </div>
  );
}

function SelectionPattern() {
  const [active, setActive] = useState(false);
  const [selected, setSelected] = useState(false);
  const first = samples[0]!;
  const state = stateExamples()[1] ?? stateExamples()[0];
  return (
    <section className="space-y-4">
      <Button onClick={() => setActive((value) => !value)}>{active ? 'Done selecting' : 'Select entries'}</Button>
      <ul>
        <ShelfListRow
          href={`/en/subjects/${first.id}`}
          title={first.title}
          cover={first.cover}
          status={state ? <a href={`/en/library?state=${state.id}`}>{state.label}</a> : undefined}
          selectable={active}
          selected={selected}
          onSelectedChange={setSelected}
          labels={{ select: `Select ${first.title}`, menu: `Actions for ${first.title}` }}
        />
      </ul>
      {active ? <p role="status">{selected ? '1 entry selected' : 'No entries selected'}</p> : null}
    </section>
  );
}

function StateFilterPattern() {
  const states = stateExamples();
  const [selected, setSelected] = useState<(typeof states)[number] | null>(() => states[1] ?? states[0] ?? null);
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm" aria-label={m.library_states()}>
      <span>{m.library_states()}</span>
      {selected ? (
        <>
          <Badge variant="secondary" data-state-id={selected.id}>
            {selected.label}
          </Badge>
          <a
            href="/en/library"
            onClick={(event) => {
              event.preventDefault();
              setSelected(null);
            }}
            className="text-primary underline-offset-4 hover:underline"
          >
            {m.library_state_all()}
          </a>
        </>
      ) : (
        <span>{m.library_state_all()}</span>
      )}
    </p>
  );
}

export const TrackedLayouts: Story = {
  render: () => (
    <PatternStory>
      <TrackedLayoutsPattern />
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const states = stateExamples();
    const selected = states[1] ?? states[0];
    if (!selected) throw new Error('The recorded Book profile has no entry states.');
    for (const [index, sample] of samples.entries()) {
      const subjectLinks = canvas.getAllByRole('link', { name: sample.title });
      expect(subjectLinks.length).toBeGreaterThanOrEqual(2);
      for (const link of subjectLinks) await expect(link).toHaveAttribute('href', `/en/subjects/${sample.id}`);
      const stateLinks = canvas.getAllByRole('link', { name: states[index]!.label });
      expect(stateLinks.length).toBeGreaterThanOrEqual(2);
      for (const link of stateLinks)
        await expect(link).toHaveAttribute('href', `/en/library?state=${states[index]!.id}`);
    }
  },
};
export const GridSmall: Story = {
  render: () => (
    <PatternStory>
      <Grid size="small" />
    </PatternStory>
  ),
};
export const GridMedium: Story = {
  render: () => (
    <PatternStory>
      <Grid size="medium" />
    </PatternStory>
  ),
};
export const GridLarge: Story = {
  render: () => (
    <PatternStory>
      <Grid size="large" />
    </PatternStory>
  ),
};
export const StateFilterActive: Story = {
  render: () => (
    <PatternStory>
      <StateFilterPattern />
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const selected = stateExamples()[1] ?? stateExamples()[0];
    if (!selected) throw new Error('The recorded Book profile has no entry states.');
    const clear = canvas.getByRole('link', { name: m.library_state_all() });
    await expect(canvas.getByText(selected.label)).toHaveAttribute('data-state-id', selected.id);
    await userEvent.click(clear);
    await expect(canvas.getByText(m.library_state_all())).toBeVisible();
    await expect(canvas.queryByText(selected.label)).toBeNull();
  },
};
export const SelectionMode: Story = {
  render: () => (
    <PatternStory>
      <SelectionPattern />
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Select entries' }));
    const selection = await canvas.findByRole('checkbox', { name: 'Select Kokoro' });
    await userEvent.click(selection);
    await expect(selection).toBeChecked();
    await expect(canvas.getByRole('status')).toHaveTextContent('1 entry selected');
  },
};
export const StatusChips: Story = {
  render: () => (
    <PatternStory>
      <ul className="space-y-3">
        {stateExamples().map((state) => (
          <li key={state.id} className="flex items-center gap-3">
            <span>{state.label}</span>
            <a href={`/en/library?state=${state.id}`}>
              <Badge variant="secondary">{state.label}</Badge>
            </a>
          </li>
        ))}
      </ul>
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const state of stateExamples())
      await expect(canvas.getByRole('link', { name: state.label })).toHaveAttribute(
        'href',
        `/en/library?state=${state.id}`,
      );
  },
};
