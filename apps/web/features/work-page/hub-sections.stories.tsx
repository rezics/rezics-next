import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import * as fixture from '../work-levels/fixtures.ts';
import { copyOf } from '../work-levels/messages.ts';
import { ConnectionsPreviewView, PartsPreviewView } from '../work-levels/previews.tsx';
import type { Loaded, PartsPage, RelationsPage, WholesPage } from '../work-levels/types.ts';
import { PageContainer } from '../shell/page.tsx';
import { messages } from './messages.ts';

// The hub's public structural regions share the same preview views across media.
// The server adapter tests exercise Parts itself and the absence of an identity gate.
function PublicStructure({
  parts,
  wholes,
  relations,
}: {
  parts: Loaded<PartsPage>;
  wholes: Loaded<WholesPage>;
  relations: Loaded<RelationsPage>;
}) {
  return (
    <PageContainer className="grid max-w-3xl gap-8 py-8">
      <PartsPreviewView
        parts={parts}
        wholes={wholes}
        names={fixture.names}
        workRef={fixture.workRef}
        pageMessages={messages.en}
        t={copyOf('en')}
      />
      <ConnectionsPreviewView
        relations={relations}
        workRef={fixture.workRef}
        locale="en"
        pageMessages={messages.en}
        t={copyOf('en')}
      />
    </PageContainer>
  );
}

const meta = {
  title: 'Work page/Hub/Public structure',
  component: PublicStructure,
  args: { parts: fixture.parts, wholes: fixture.wholes, relations: fixture.relations },
} satisfies Meta<typeof PublicStructure>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SignedOut: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('A Certain Magical Index NT 1')).toBeVisible();
    await expect(canvas.getByText('Part of')).toBeVisible();
    await expect(canvas.getByText('Spin-offs')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'All parts' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'All connections' })).toBeVisible();
    await expect(canvas.queryByText(/Sign in/)).toBeNull();
  },
};

export const Phone: Story = {
  ...SignedOut,
  globals: { viewport: { value: 'phone' } },
};

export const WithheldTargets: Story = {
  args: {
    parts: {
      ok: true,
      data: { ...(fixture.parts.ok ? fixture.parts.data : ({} as PartsPage)), parts: [] },
    },
    wholes: {
      ok: true,
      data: { ...(fixture.wholes.ok ? fixture.wholes.data : ({} as WholesPage)), wholes: [] },
    },
    relations: {
      ok: true,
      data: {
        ...(fixture.relations.ok ? fixture.relations.data : ({} as RelationsPage)),
        items: [],
      },
    },
  },
  async play({ canvasElement }) {
    await expect(within(canvasElement).queryByText(/A Certain Magical Index/)).toBeNull();
    await expect(within(canvasElement).queryByRole('link')).toBeNull();
  },
};

export const Unavailable: Story = {
  args: {
    parts: { ok: false, failure: 'unavailable' },
    wholes: { ok: false, failure: 'unavailable' },
    relations: { ok: false, failure: 'unavailable' },
  },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getAllByRole('alert')).toHaveLength(2);
    await expect(within(canvasElement).queryByText(/A Certain Magical Index/)).toBeNull();
  },
};
