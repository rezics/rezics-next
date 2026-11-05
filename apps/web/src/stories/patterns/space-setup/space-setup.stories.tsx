import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { SpaceSetupForm, emptySetup, type SetupTransport } from './space-setup';
import { applySetupResult, type SetupSnapshot, type SetupCommand } from '../../../community/space-setup';
import spaceRecording from '../../../kernel/recorded/space.json';
import realmRecording from '../../../kernel/recorded/realm.json';
import boardRecording from '../../../kernel/recorded/board-realm.json';
import { m } from '../../../paraglide/messages.js';
import { localizeUrl } from '../../../paraglide/runtime.js';
import { PatternStory } from '../../page';
import type { BoardChoiceSource } from '../../../community/setup-board-picker';

const meta = {
  title: 'Patterns/Community/Space Setup',
  component: SpaceSetupForm,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'One progressive setup region, reused by Pages. Each save uses the existing ordinary command and returned identity. These transport-boundary interactions demonstrate drafts, named point-read selections and recovery; native authorization and visual review remain integration work. Review the same IDs using phone390/desktop1280, locale and theme globals.',
      },
    },
  },
} satisfies Meta<typeof SpaceSetupForm>;
export default meta;
type Story = StoryObj<typeof meta>;
const recorded: SetupSnapshot = {
  kind: 'ready',
  space: {
    id: spaceRecording.space.spaceId,
    head: spaceRecording.space.headRevisionId,
    title: spaceRecording.space.title,
    summary: spaceRecording.space.summary,
    address: spaceRecording.space.address,
    realmId: realmRecording.realm.realmId,
  },
  realm: {
    id: realmRecording.realm.realmId,
    head: realmRecording.realm.headRevisionId,
    title: realmRecording.realm.title,
    summary: realmRecording.realm.summary,
    visibility: 'public',
    contextId: realmRecording.realm.contextId,
    schemeId: null,
  },
  permitted: { address: true, settings: true, scheme: true, board: true },
};
// Explicit command/point-read fixtures, never the page's production transport or an options catalogue.
const schemeId = '0192f3a0-6c1e-7b2a-9d4e-000000000003';
const conceptId = '0192f3a0-6c1e-7b2a-9d4e-000000000004';
function boundary(status: 403 | 412 | 503, current = emptySetup): SetupTransport {
  return {
    command: async () => ({
      kind: 'failure',
      status,
      reason: status === 403 ? 'denied' : status === 412 ? 'conflict' : 'unavailable',
    }),
    read: async () => current,
    choice: async () => ({ kind: 'failure', reason: 'unavailable', status: 503 }),
  };
}
function Journey({ retry = false }: { retry?: boolean }) {
  let current = emptySetup;
  let first: SetupCommand | null = null;
  let attempts = 0;
  const transport: SetupTransport = {
    command: async (command) => {
      if (retry && command.step === 'space') {
        attempts++;
        if (!first) first = command;
        else await expect(command).toEqual(first);
        if (attempts === 1) return { kind: 'failure', reason: 'unavailable', status: 503 };
      }
      const result =
        command.step === 'space'
          ? {
              kind: 'space' as const,
              space: {
                ...recorded.space!,
                title: command.title,
                summary: command.summary,
                address: null,
                realmId: null,
              },
            }
          : command.step === 'address'
            ? {
                kind: 'space' as const,
                space: { ...current.space!, head: crypto.randomUUID(), address: command.address },
              }
            : command.step === 'realm' || command.step === 'settings'
              ? {
                  kind: 'realm' as const,
                  realm: {
                    ...recorded.realm!,
                    head: crypto.randomUUID(),
                    title: command.title,
                    summary: command.summary,
                    visibility: command.visibility,
                    contextId: command.contextId,
                  },
                }
              : command.step === 'scheme'
                ? {
                    kind: 'realm' as const,
                    realm: { ...current.realm!, head: crypto.randomUUID(), schemeId: command.schemeId },
                  }
                : { kind: 'board' as const, id: boardRecording.board.id };
      current = { ...applySetupResult(current, result), permitted: recorded.permitted };
      return result;
    },
    read: async () => current,
    choice: async (kind, id) => {
      const expected = kind === 'context' ? realmRecording.realm.contextId : kind === 'scheme' ? schemeId : conceptId;
      return id === expected
        ? { id, label: kind === 'context' ? 'Reading' : kind === 'scheme' ? 'Discussion' : 'Introductions' }
        : { kind: 'failure', reason: 'denied', status: 404 };
    },
  };
  const boardChoices: BoardChoiceSource = {
    schemes: async () => ({ schemes: [{ id: schemeId, label: 'Discussion' }], next: null }),
    concepts: async ({ schemeId: selected }) => ({
      concepts: selected === schemeId ? [{ id: conceptId, label: 'Introductions' }] : [],
      next: null,
    }),
  };
  return <SpaceSetupForm initial={emptySetup} transport={transport} boardChoices={boardChoices} />;
}
const render: NonNullable<Story['render']> = (args) => (
  <PatternStory visitor="Signed In" path="/realms/new">
    <div className="mx-auto max-w-5xl p-4 sm:p-8">
      <SpaceSetupForm {...args} />
    </div>
  </PatternStory>
);
const journeyRender = (retry = false) => (
  <PatternStory visitor="Signed In" path="/realms/new">
    <div className="mx-auto max-w-5xl p-4 sm:p-8">
      <Journey retry={retry} />
    </div>
  </PatternStory>
);
export const Rest: Story = { args: { initial: emptySetup, transport: boundary(503) }, render };
export const EnteredData: Story = {
  args: Rest.args,
  render,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.type(view.getByRole('textbox', { name: m.space_setup_title() }), 'The Evening Reading Room');
    await userEvent.type(
      view.getByRole('textbox', { name: m.space_setup_summary() }),
      'A place for slow novels and thoughtful discussion.',
    );
    await userEvent.click(view.getByRole('button', { name: m.editor_cancel() }));
    await userEvent.click(view.getByRole('button', { name: m.space_setup_resume() }));
    await expect(view.getByRole('textbox', { name: m.space_setup_title() })).toHaveValue('The Evening Reading Room');
  },
};
export const RetryPreservesWork: Story = {
  args: Rest.args,
  render: () => journeyRender(true),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.type(view.getByRole('textbox', { name: m.space_setup_title() }), 'The Evening Reading Room');
    await userEvent.click(view.getByRole('button', { name: m.space_setup_create_space() }));
    await expect(view.getByRole('textbox', { name: m.space_setup_title() })).toBeDisabled();
    await userEvent.click(await view.findByRole('button', { name: m.space_setup_retry() }));
    await view.findByRole('textbox', { name: m.space_setup_address() });
    await expect(view.getAllByText('The Evening Reading Room').length).toBeGreaterThan(0);
    await expect(view.queryByText(m.space_setup_complete())).toBeNull();
  },
};
export const ConfiguredRealm: Story = { args: { initial: recorded, transport: boundary(503, recorded) }, render };
export const HeadConflict: Story = {
  args: {
    initial: recorded,
    transport: boundary(412, {
      ...recorded,
      space: recorded.space && { ...recorded.space, head: realmRecording.realm.headRevisionId },
    }),
  },
  render,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const address = view.getByRole('textbox', { name: m.space_setup_address() });
    await userEvent.clear(address);
    await userEvent.type(address, 'evening-reading-room');
    await userEvent.click(view.getByRole('button', { name: m.space_setup_save_address() }));
    await view.findByText(m.space_setup_conflict());
    await userEvent.click(view.getByRole('button', { name: m.space_setup_refresh() }));
    await expect(address).toHaveValue('evening-reading-room');
    await expect(view.getByRole('link', { name: m.space_setup_home() })).toBeVisible();
  },
};
export const CurrentAuthorityRefused: Story = {
  args: {
    initial: recorded,
    transport: boundary(403, {
      ...recorded,
      permitted: { address: false, settings: false, scheme: false, board: false },
    }),
  },
  render,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const address = view.getByRole('textbox', { name: m.space_setup_address() });
    await userEvent.clear(address);
    await userEvent.type(address, 'keep-this-address');
    await userEvent.click(view.getByRole('button', { name: m.space_setup_save_address() }));
    await view.findByText(m.space_setup_denied());
    await expect(address).toHaveValue('keep-this-address');
    await userEvent.click(view.getByRole('button', { name: m.space_setup_refresh() }));
    await expect(view.queryByRole('button', { name: m.space_setup_save_address() })).toBeDisabled();
    await expect(view.queryByText(m.space_setup_complete())).toBeNull();
  },
};
export const Unavailable: Story = {
  args: {
    initial: { kind: 'failure', reason: 'unavailable', status: 503 },
    transport: { ...boundary(503), read: async () => ({ kind: 'failure', reason: 'unavailable', status: 503 }) },
  },
  render,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.space_setup_refresh() }));
    await view.findByText(m.space_setup_unavailable());
    await expect(view.getByRole('textbox', { name: m.space_setup_title() })).toBeDisabled();
  },
};
export const Saving: Story = {
  args: { initial: emptySetup, transport: { ...boundary(503), command: () => new Promise(() => {}) } },
  render,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.type(view.getByRole('textbox', { name: m.space_setup_title() }), 'The Evening Reading Room');
    await userEvent.click(view.getByRole('button', { name: m.space_setup_create_space() }));
    await view.findByRole('status');
    await expect(view.getByRole('button', { name: m.editor_cancel() })).toBeDisabled();
  },
};
export const SelectionUnavailable: Story = {
  args: ConfiguredRealm.args,
  render,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.space_setup_continue() }));
    await userEvent.click(view.getByRole('button', { name: m.space_setup_resolve() }));
    await view.findByRole('alert');
    await expect(view.getByRole('button', { name: m.space_setup_save_settings() })).toBeDisabled();
    await expect(view.getByRole('textbox', { name: m.space_setup_title() })).toHaveValue(recorded.realm?.title);
  },
};
export const Loading: Story = {
  args: { initial: recorded, transport: { ...boundary(503, recorded), choice: () => new Promise(() => {}) } },
  render,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.space_setup_continue() }));
    await userEvent.click(view.getByRole('button', { name: m.space_setup_resolve() }));
    await expect(view.getByRole('button', { name: m.space_setup_loading() })).toBeDisabled();
  },
};
async function choose(view: ReturnType<typeof within>, id: string) {
  await userEvent.type(view.getByRole('textbox', { name: m.space_setup_reference() }), id);
  await userEvent.click(view.getByRole('button', { name: m.space_setup_resolve() }));
}
async function reachRealm(view: ReturnType<typeof within>) {
  await userEvent.type(view.getByRole('textbox', { name: m.space_setup_title() }), 'The Evening Reading Room');
  await userEvent.click(view.getByRole('button', { name: m.space_setup_create_space() }));
  await userEvent.type(await view.findByRole('textbox', { name: m.space_setup_address() }), 'evening-reading-room');
  await userEvent.click(view.getByRole('button', { name: m.space_setup_save_address() }));
  await view.findByRole('textbox', { name: m.space_setup_reference() });
  await userEvent.type(view.getByRole('textbox', { name: m.space_setup_title() }), 'Evening readers');
  await choose(view, realmRecording.realm.contextId);
  await expect(view.getByRole('button', { name: m.space_setup_create_realm() })).toBeEnabled();
}
export const Selection: Story = {
  args: Rest.args,
  render: () => journeyRender(),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await reachRealm(view);
    await expect(view.getAllByText('Reading').length).toBeGreaterThan(0);
    await userEvent.click(view.getByRole('button', { name: m.space_setup_back() }));
    await userEvent.click(view.getByRole('button', { name: m.space_setup_continue() }));
    await expect(view.getByRole('textbox', { name: m.space_setup_title() })).toHaveValue('Evening readers');
    await expect(view.getByRole('button', { name: m.space_setup_create_realm() })).toBeEnabled();
  },
};
export const Created: Story = {
  args: Rest.args,
  render: () => journeyRender(),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await reachRealm(view);
    await userEvent.click(view.getByRole('button', { name: m.space_setup_create_realm() }));
    await view.findByRole('button', { name: m.space_setup_save_scheme() });
    await userEvent.click(await view.findByRole('radio', { name: 'Discussion' }));
    await userEvent.click(view.getByRole('button', { name: m.space_setup_save_scheme() }));
    await view.findByRole('button', { name: m.space_setup_create_board() });
    await userEvent.type(view.getByRole('textbox', { name: m.space_setup_title() }), 'Start here');
    await userEvent.click(await view.findByRole('radio', { name: 'Introductions' }));
    await userEvent.click(view.getByRole('button', { name: m.space_setup_create_board() }));
    await expect(await view.findByRole('link', { name: m.space_setup_open_board() })).toHaveAttribute(
      'href',
      localizeUrl(new URL(`/boards/${boardRecording.board.id}`, 'http://rezics.local')).pathname,
    );
    await expect(view.getByRole('link', { name: m.space_setup_home() })).toHaveAttribute(
      'href',
      localizeUrl(new URL('/spaces/evening-reading-room', 'http://rezics.local')).pathname,
    );
    await expect(view.queryByRole('button', { name: m.space_setup_create_board() })).toBeNull();
  },
};

// Illustrative display text over the existing transport fixtures; no new recording or native proof.
const longTitle = 'A community for reading together across languages — ' + 'ReadingWithoutABreak'.repeat(12);
export const LongSavedSummary: Story = {
  args: {
    initial: { ...recorded, space: { ...recorded.space!, title: longTitle } },
    transport: boundary(503, recorded),
  },
  render,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByRole('heading', { level: 3, name: longTitle })).toBeVisible();
    const disclosure = view.getByText(m.space_setup_details_heading());
    view.getByRole('button', { name: m.space_setup_identity() }).focus();
    await userEvent.tab();
    await expect(disclosure).toHaveFocus();
    await expect(disclosure.closest('details')).not.toHaveAttribute('open');
    await userEvent.click(disclosure);
    await expect(view.getByText(m.space_setup_identity_hint())).toBeVisible();
    await expect(view.getByText(m.space_setup_saved_hint())).toBeVisible();
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};
export const LongResult: Story = {
  args: Rest.args,
  render: () => journeyRender(),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await reachRealm(view);
    await userEvent.click(view.getByRole('button', { name: m.space_setup_create_realm() }));
    await userEvent.click(await view.findByRole('radio', { name: 'Discussion' }));
    await userEvent.click(view.getByRole('button', { name: m.space_setup_save_scheme() }));
    await view.findByRole('button', { name: m.space_setup_create_board() });
    await userEvent.type(view.getByRole('textbox', { name: m.space_setup_title() }), longTitle);
    await userEvent.click(await view.findByRole('radio', { name: 'Introductions' }));
    await userEvent.click(view.getByRole('button', { name: m.space_setup_create_board() }));
    await expect(await view.findByRole('heading', { level: 3, name: longTitle })).toBeVisible();
    const result = view.getByRole('article', { name: m.space_setup_complete() });
    await expect(within(result).getByText(m.space_setup_visibility())).toBeVisible();
    const open = view.getByRole('link', { name: m.space_setup_open_board() });
    const home = view.getByRole('link', { name: m.space_setup_home() });
    open.focus();
    await expect(open).toHaveFocus();
    await userEvent.tab();
    await expect(home).toHaveFocus();
    for (const control of [open, home]) {
      await expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};
export const LongSavedSummaryRtl: Story = {
  ...LongSavedSummary,
  render: (args) => (
    <PatternStory visitor="Signed In" path="/realms/new">
      <div dir="rtl" className="mx-auto max-w-5xl p-4 sm:p-8">
        <SpaceSetupForm {...args} />
      </div>
    </PatternStory>
  ),
};
export const LongResultRtl: Story = {
  ...LongResult,
  render: () => <div dir="rtl">{journeyRender()}</div>,
};
