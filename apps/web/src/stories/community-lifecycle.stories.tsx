import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ContainerLifecycleControls } from '../community/container-lifecycle-controls';
import type { ContainerLifecycleAdapter } from '../community/container-lifecycle';
import { localizeHref } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { SpacePage } from '../community/space-page';
import type { SpacePageData } from '../community/space';
import { AppShell } from '../shell/shell';
import space from '../kernel/recorded/space.json';
import realm from '../kernel/recorded/realm.json';
import boards from '../kernel/recorded/realm-boards.json';
import { PatternStory } from './page';
import {
  exampleTarget,
  exampleTitle,
  lifecycleExampleAdapter,
  LifecycleExample,
  type Scenario,
} from './patterns/community-lifecycle/example';
import { removeAndRestore } from './patterns/community-lifecycle/community-lifecycle.stories';

const page: SpacePageData = {
  space: { id: space.space.spaceId, title: space.space.title, summary: space.space.summary },
  realm: {
    id: realm.realm.realmId,
    title: realm.realm.title,
    summary: realm.realm.summary,
    visibility: 'public',
    viewer: null,
    published: [],
    boards: boards.items.map((board) => ({
      id: board.id,
      title: board.title,
      purpose: 'discussion',
      visibility: 'published',
    })),
  },
};
function Example() {
  const adapter = useMemo(() => lifecycleExampleAdapter('active'), []);
  return (
    <PatternStory visitor="Signed In" path="/spaces/quiet-novel-club">
      <AppShell>
        <SpacePage page={page} lifecycleAdapter={adapter} />
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Community/Container lifecycle',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        story:
          'Uses the supplied Realm recording and injected lifecycle response fixtures for presentation. These examples do not prove native approval or backend acceptance.',
      },
    },
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
export const ManagementJourney: Story = { render: () => <Example />, play: removeAndRestore };

function LifecyclePanel({
  scenario = 'active',
  title = exampleTitle,
  adapter,
  visitor = 'Signed In',
  path = `/realms/${exampleTarget.id}`,
}: {
  scenario?: Scenario;
  title?: string;
  adapter?: ContainerLifecycleAdapter;
  visitor?: 'Signed In' | 'Signed Out';
  path?: string;
}) {
  const fixture = useMemo(() => adapter ?? lifecycleExampleAdapter(scenario), [adapter, scenario]);
  return (
    <PatternStory visitor={visitor} path={path}>
      <main className="mx-auto w-full min-w-0 max-w-2xl p-4">
        <ContainerLifecycleControls target={exampleTarget} title={title} adapter={fixture} />
      </main>
    </PatternStory>
  );
}

function RefusedPanel() {
  return (
    <PatternStory visitor="Signed In" path={`/realms/${exampleTarget.id}`}>
      <main className="mx-auto w-full min-w-0 max-w-2xl p-4">
        <LifecycleExample scenario="denied" />
      </main>
    </PatternStory>
  );
}

function ConflictPanel() {
  return (
    <PatternStory visitor="Signed In" path={`/realms/${exampleTarget.id}`}>
      <main className="mx-auto w-full min-w-0 max-w-2xl p-4">
        <LifecycleExample scenario="conflict" />
      </main>
    </PatternStory>
  );
}

function RemovedRestorePanel() {
  const adapter = useMemo<ContainerLifecycleAdapter>(() => {
    const fixture = lifecycleExampleAdapter('removed');
    return {
      ...fixture,
      destination: async (target, contextId) => ({
        kind: 'available',
        target,
        contextId,
        href: localizeHref(`/realms/${target.id}`),
      }),
    };
  }, []);
  return <LifecyclePanel scenario="removed" adapter={adapter} />;
}

const longReason =
  'The Realm has a long record of repeated disruption across several discussion areas. Please preserve the complete review context, including the dates, affected participants, prior notices, and the steps already taken before this removal request.';
const longGermanReason =
  'Wiederholte Störungen haben mehrere Diskussionsbereiche über einen längeren Zeitraum beeinträchtigt. Bitte bewahren Sie den vollständigen Prüfkontext einschließlich aller Daten, früheren Hinweise, Antworten und Lösungsschritte für diesen Entfernungsantrag auf.';
const longGermanTitle =
  'Gemeinschaftlicher Leseraum für ausführliche Diskussionen über Übersetzungen, historische Quellen und redaktionelle Entscheidungen';

export const RefusalDetails: Story = {
  render: () => <RefusedPanel />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.type(
      await view.findByRole('textbox', { name: m.container_lifecycle_reason() }),
      'Repeated disruption',
    );
    await userEvent.click(view.getByRole('button', { name: m.container_lifecycle_remove() }));
    await userEvent.click(view.getByRole('button', { name: m.container_lifecycle_confirm() }));
    await expect(await view.findByRole('alert')).toHaveTextContent(m.container_lifecycle_refused());
    const details = view.getByText(m.community_management_details_problem_summary());
    await userEvent.click(details);
    await expect(view.getByText('404')).toBeVisible();
    await expect(view.getByText('not_found')).toBeVisible();
  },
};

export const ConflictNeedsReview: Story = {
  render: () => <ConflictPanel />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.type(
      await view.findByRole('textbox', { name: m.container_lifecycle_reason() }),
      'Repeated disruption',
    );
    await userEvent.click(view.getByRole('button', { name: m.container_lifecycle_remove() }));
    await userEvent.click(view.getByRole('button', { name: m.container_lifecycle_confirm() }));
    await view.findByText(m.container_lifecycle_conflict());
    await userEvent.click(view.getByRole('button', { name: m.container_lifecycle_refresh() }));
    await userEvent.click(await view.findByRole('button', { name: m.container_lifecycle_review() }));
    await expect(view.getByRole('textbox', { name: m.container_lifecycle_reason() })).toHaveValue(
      'Repeated disruption',
    );
  },
};

export const RemovedRestoreIndependentDestination: Story = {
  render: () => <RemovedRestorePanel />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.container_lifecycle_restore() }));
    await userEvent.click(view.getByRole('button', { name: m.container_lifecycle_confirm() }));
    await view.findByText(m.container_lifecycle_restored());
    await expect(view.getByRole('link', { name: m.container_lifecycle_open() })).toHaveAttribute(
      'href',
      localizeHref(`/realms/${exampleTarget.id}`),
    );
  },
};

export const MissingCurrentAdmission: Story = {
  render: () => <LifecyclePanel scenario="unavailable" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText(m.container_lifecycle_unavailable());
    await expect(view.queryByRole('button', { name: m.container_lifecycle_remove() })).toBeNull();
    await expect(view.queryByRole('button', { name: m.container_lifecycle_restore() })).toBeNull();
  },
};

export const LoadingCurrentState: Story = {
  render: () => <LifecyclePanel scenario="loading" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText(m.container_lifecycle_loading());
    await expect(view.queryByRole('button', { name: m.container_lifecycle_remove() })).toBeNull();
    await expect(view.queryByRole('button', { name: m.container_lifecycle_restore() })).toBeNull();
  },
};

export const OrphanedCurrentState: Story = {
  render: () => <LifecyclePanel scenario="orphaned" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText(m.container_lifecycle_orphaned());
    await expect(view.queryByRole('button', { name: m.container_lifecycle_remove() })).toBeNull();
    await expect(view.queryByRole('button', { name: m.container_lifecycle_restore() })).toBeNull();
  },
};

export const SignedInWithoutAdmission: Story = {
  render: () => <LifecyclePanel scenario="read-only" visitor="Signed In" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText(m.container_lifecycle_read_only());
    await expect(view.queryByRole('button', { name: m.container_lifecycle_remove() })).toBeNull();
    await expect(view.queryByRole('button', { name: m.container_lifecycle_restore() })).toBeNull();
  },
};

export const UncertainExactRetry: Story = {
  render: () => <LifecyclePanel scenario="uncertain" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.type(
      await view.findByRole('textbox', { name: m.container_lifecycle_reason() }),
      'Repeated disruption',
    );
    await userEvent.click(view.getByRole('button', { name: m.container_lifecycle_remove() }));
    await userEvent.click(view.getByRole('button', { name: m.container_lifecycle_confirm() }));
    await view.findByText(m.container_lifecycle_uncertain());
    await userEvent.click(view.getByRole('button', { name: m.container_lifecycle_retry() }));
    await expect(await view.findByText(m.container_lifecycle_removed())).toBeVisible();
    await expect(view.getByRole('textbox', { name: m.container_lifecycle_reason() })).toHaveValue(
      'Repeated disruption',
    );
  },
};

export const LongLocalizedCopy: Story = {
  globals: { locale: 'de' },
  render: () => <LifecyclePanel scenario="uncertain" title={longGermanTitle} path={`/realms/${exampleTarget.id}`} />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const textbox = await view.findByRole('textbox', { name: m.container_lifecycle_reason() });
    await userEvent.type(textbox, longGermanReason);
    await userEvent.click(view.getByRole('button', { name: m.container_lifecycle_remove() }));
    await userEvent.click(view.getByRole('button', { name: m.container_lifecycle_confirm() }));
    await view.findByRole('alert');
    await expect(textbox).toHaveValue(longGermanReason);
    await expect(view.getByText(longGermanTitle)).toBeVisible();
    await expect(view.getByRole('alert')).toHaveTextContent(m.container_lifecycle_uncertain());
  },
};
