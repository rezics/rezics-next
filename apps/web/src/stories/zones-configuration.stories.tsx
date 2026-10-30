import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { zoneEditorFixture } from '../features/zones/editor/fixture';
import { ZoneEditorSession } from '../features/zones/editor/model';
import { EditorLoading, ZoneConfigurationEditor } from '../features/zones/editor/view';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

const meta = {
  title: 'Pages/Community/Zone configuration',
  parameters: {
    layout: 'fullscreen',
    docs: { description: { component: 'Contract-shaped fake API outcomes. Native and visual review remain pending.' } },
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
type Mode =
  | 'ready'
  | 'dirty'
  | 'conflict'
  | 'missing'
  | 'denied'
  | 'actions'
  | 'source'
  | 'validation'
  | 'saved'
  | 'published';

function EditorStory({ mode = 'ready' }: { mode?: Mode }) {
  const [session] = useState(() => {
    const fixture = zoneEditorFixture();
    if (mode === 'missing' || mode === 'denied') {
      fixture.initial.resource = {
        kind: 'failure',
        status: mode === 'missing' ? 404 : 403,
        code: mode === 'missing' ? 'not_found' : 'forbidden',
      };
      fixture.initial.permissions = { configure: false, publish: false, available: true };
    }
    if (mode === 'actions') {
      fixture.mode.actionsStatus = 400;
      fixture.initial.permissions = {
        configure: false,
        publish: false,
        available: false,
        failure: { kind: 'failure', status: 400, code: 'invalid_request' },
      };
    }
    if (mode === 'source') {
      fixture.mode.previewStatus = 503;
      fixture.mode.optionsAvailable = false;
      fixture.initial.options.scopes = { kind: 'failure', status: 503, code: 'dependency_unavailable' };
      fixture.initial.options.collections = { kind: 'failure', status: 503, code: 'semantic_not_ready' };
    }
    const value = new ZoneEditorSession(fixture.transport, fixture.initial);
    if (['dirty', 'conflict', 'validation', 'saved'].includes(mode)) {
      const draft = structuredClone(value.snapshot().draft!);
      draft.configuration.labels.en = mode === 'validation' ? '' : 'My Field Notes';
      value.edit(draft);
    }
    if (mode === 'conflict') fixture.externalChange();
    return value;
  });
  useEffect(() => {
    if (mode === 'conflict' || mode === 'validation' || mode === 'saved') void session.save();
    if (mode === 'source') void session.preview('');
    if (mode === 'published') void session.publish('unlisted');
  }, [mode, session]);
  return (
    <PatternStory visitor="Signed In" path="/my/zones/0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11/edit">
      <AppShell>
        <ZoneConfigurationEditor session={session} locale={getLocale()} />
      </AppShell>
    </PatternStory>
  );
}

export const Desktop: Story = {
  globals: { viewport: { value: 'desktop1280' } },
  render: () => <EditorStory />,
};
export const Phone: Story = {
  globals: { viewport: { value: 'phone390' } },
  render: () => <EditorStory />,
};
export const Dirty: Story = {
  globals: { viewport: { value: 'phone390' } },
  render: () => <EditorStory mode="dirty" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByRole('button', { name: m.zone_editor_preview() })).toBeDisabled();
    await expect(view.getByRole('button', { name: m.zone_editor_save() })).toBeEnabled();
  },
};
export const Conflict: Story = {
  globals: { viewport: { value: 'desktop1280' } },
  render: () => <EditorStory mode="conflict" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const reapply = await view.findByRole('button', { name: m.zone_editor_reapply() });
    await userEvent.click(reapply);
    await expect(view.getByRole('button', { name: m.zone_editor_save() })).toBeEnabled();
  },
};
export const Missing: Story = { render: () => <EditorStory mode="missing" /> };
export const Denied: Story = { render: () => <EditorStory mode="denied" /> };
export const ActionsUnavailable: Story = { render: () => <EditorStory mode="actions" /> };
export const SourceUnavailable: Story = { render: () => <EditorStory mode="source" /> };
export const Validation: Story = { render: () => <EditorStory mode="validation" /> };
export const Saved: Story = { render: () => <EditorStory mode="saved" /> };
export const Published: Story = { render: () => <EditorStory mode="published" /> };
export const Loading: Story = {
  render: () => (
    <PatternStory visitor="Signed In">
      <AppShell>
        <EditorLoading />
      </AppShell>
    </PatternStory>
  ),
};
