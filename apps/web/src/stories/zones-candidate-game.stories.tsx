import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { PageStory, pageReady } from './page';
import { videoGameZoneIds, videoGameWorks } from '../zones/candidates/game';

const title = 'Zones/Candidates/Video games (gated preview, deferred)';
const previewPath = `/zones/${videoGameZoneIds.admittedPreview}`;

function zonePath(id: string): string {
  return `/zones/${id}`;
}

function page(path: string) {
  return <PageStory visitor="Signed Out" path={path} />;
}

function routeLink(canvasElement: HTMLElement, zoneId: string, route = ''): HTMLElement {
  const suffix = `/zones/${zoneId}${route ? `/${route}` : ''}`;
  const link = within(canvasElement)
    .getAllByRole('link')
    .find((item) => (item.getAttribute('href') ?? '').split(/[?#]/, 1)[0]!.endsWith(suffix));
  if (!link) throw new Error(`The Zone route link ${route || '(home)'} is missing.`);
  return link;
}

async function activateByKeyboard(link: HTMLElement): Promise<void> {
  link.focus();
  await userEvent.keyboard('{Enter}');
}

const meta = {
  title,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Gated development preview, deferred from public catalogue claims. The admitted home uses fictional VideoGame works; add-ons and releases remain static starter routes. No official instance, release list, add-on list, commerce state, or installed-title state is asserted.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const AdmittedPreview: Story = {
  name: 'Admitted preview with fictional works',
  render: () => page(previewPath),
  parameters: {
    docs: {
      description: {
        story:
          'The real Zone route renders the starter home through an explicit development-only admitted fixture. Each row is a fictional schema:VideoGame work and opens its own Zone subject read.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const canvas = within(canvasElement);
    const mainElement = () => canvas.getByRole('main');
    const main = () => within(mainElement());
    await expect(await main().findByRole('heading', { name: 'Video games', level: 2 })).toBeVisible();
    await expect(await main().findByText(/Development preview, deferred/)).toBeVisible();

    await activateByKeyboard(routeLink(canvasElement, videoGameZoneIds.admittedPreview, 'add-ons'));
    await expect(await main().findByRole('heading', { name: 'Add-ons', level: 2 })).toBeVisible();
    expect(mainElement().querySelector('[data-slot="type-list"]')).toBeNull();

    await activateByKeyboard(routeLink(canvasElement, videoGameZoneIds.admittedPreview));
    await expect(await main().findByRole('heading', { name: 'Video games', level: 2 })).toBeVisible();

    await activateByKeyboard(routeLink(canvasElement, videoGameZoneIds.admittedPreview, 'releases'));
    await expect(await main().findByRole('heading', { name: 'Releases', level: 2 })).toBeVisible();
    expect(mainElement().querySelector('[data-slot="type-list"]')).toBeNull();

    await activateByKeyboard(routeLink(canvasElement, videoGameZoneIds.admittedPreview));
    await expect(await main().findByRole('heading', { name: 'Video games', level: 2 })).toBeVisible();

    const firstWork = videoGameWorks[0]!;
    const subjectLink = canvas.getByRole('link', { name: firstWork.label });
    expect(subjectLink.getAttribute('href')).toContain(
      `/zones/${videoGameZoneIds.admittedPreview}/subjects/${firstWork.id}`,
    );
    await activateByKeyboard(subjectLink);
    await expect(await canvas.findByText(firstWork.description)).toBeVisible();

    await activateByKeyboard(routeLink(canvasElement, videoGameZoneIds.admittedPreview));
    await expect(await main().findByRole('heading', { name: 'Video games', level: 2 })).toBeVisible();
  },
};

export const StaticAddOns: Story = {
  name: 'Static add-ons route',
  render: () => page(`${previewPath}/add-ons`),
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const mainElement = within(canvasElement).getByRole('main');
    const main = within(mainElement);
    await expect(await main.findByRole('heading', { name: 'Add-ons', level: 2 })).toBeVisible();
    expect(mainElement.querySelector('[data-slot="type-list"]')).toBeNull();
  },
};

export const StaticReleases: Story = {
  name: 'Static releases route',
  render: () => page(`${previewPath}/releases`),
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const mainElement = within(canvasElement).getByRole('main');
    const main = within(mainElement);
    await expect(await main.findByRole('heading', { name: 'Releases', level: 2 })).toBeVisible();
    expect(mainElement.querySelector('[data-slot="type-list"]')).toBeNull();
  },
};

export const ReadyEmpty: Story = {
  name: 'Ready empty home',
  render: () => page(zonePath(videoGameZoneIds.readyEmpty)),
  parameters: {
    docs: {
      description: {
        story: 'The Zone read succeeds and returns an empty VideoGame result with no continuation.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const main = within(within(canvasElement).getByRole('main'));
    await expect(await main.findByRole('status')).toBeVisible();
    expect(main.queryByRole('link', { name: videoGameWorks[0]!.label })).toBeNull();
  },
};

export const SparseHome: Story = {
  name: 'Sparse home',
  render: () => page(zonePath(videoGameZoneIds.sparse)),
  parameters: {
    docs: {
      description: {
        story: 'A successful admitted preview with one fictional VideoGame work and no implied total count.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const main = within(within(canvasElement).getByRole('main'));
    await expect(await main.findByRole('link', { name: videoGameWorks[0]!.label })).toBeVisible();
    expect(main.queryByRole('link', { name: videoGameWorks[1]!.label })).toBeNull();
  },
};

export const PlatformClosed: Story = {
  name: 'Platform closed (403 platform_closed)',
  render: () => page(zonePath(videoGameZoneIds.platformClosed)),
  parameters: {
    docs: {
      description: {
        story:
          'The exact Zone read returns 403 platform_closed. The app keeps its existing fail-closed route behavior; this preview does not turn the denial into an empty list.',
      },
    },
  },
};

export const SemanticNotReady: Story = {
  name: 'Semantic not ready (503, Retry-After 1)',
  render: () => page(zonePath(videoGameZoneIds.semanticNotReady)),
  parameters: {
    docs: {
      description: {
        story:
          'The Zone read returns 503 semantic_not_ready with Retry-After: 1 and renders the existing unavailable state.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const main = within(within(canvasElement).getByRole('main'));
    await expect(await main.findByRole('button')).toBeVisible();
  },
};

export const ConcealedPrivate: Story = {
  name: 'Concealed private target (404)',
  render: () => page(zonePath(videoGameZoneIds.concealedPrivate)),
  parameters: {
    docs: {
      description: { story: 'An unreadable private Zone is concealed with the same 404 page used for a missing Zone.' },
    },
  },
};

export const MissingTarget: Story = {
  name: 'Missing target (404)',
  render: () => page(zonePath(videoGameZoneIds.missing)),
  parameters: {
    docs: {
      description: { story: 'A missing Zone receives the same 404 page as a concealed private target.' },
    },
  },
};
