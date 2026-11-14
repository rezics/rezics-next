import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { PageStory, pageReady } from './page';
import { visualNovelZoneIds } from '../zones/candidates/visual-novel';

const meta = {
  title: 'Zones/Candidates/Visual novels',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Development preview · deferred. This candidate has no adopted official-instance roster and makes no public dynamic-release claim. Fictional work names are authored preview copy.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function routePath(zoneId: string, route = ''): string {
  return `/zones/${zoneId}${route ? `/${route}` : ''}`;
}

async function readZone(zoneId: string, route = ''): Promise<Response> {
  return fetch(`/api/zones/${zoneId}:readPage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: { route } }),
  });
}

async function assertFailure(zoneId: string, status: number, error: string, retryAfter?: string): Promise<void> {
  const response = await readZone(zoneId);
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error });
  expect(response.headers.get('retry-after')).toBe(retryAfter ?? null);
}

export const AdmittedPreview: Story = {
  name: 'Gated preview · admitted · deferred',
  parameters: {
    docs: {
      description: {
        story:
          'The real Zone route is admitted for this development preview. Its TypeList uses no fixture reads; all visible work names are fictional copy, and the official-instance roster remains deferred.',
      },
    },
  },
  render: () => <PageStory visitor="Signed Out" path={routePath(visualNovelZoneIds.preview)} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const view = within(canvasElement);
    await view.findByRole('heading', { name: 'Visual novels' });
    await view.findByText(/Paper Moon Archive/);

    await userEvent.click(await view.findByRole('link', { name: /releases/i }));
    await view.findByRole('heading', { name: 'Releases' });
    const releases = await readZone(visualNovelZoneIds.preview, 'releases');
    expect(releases.status).toBe(200);
    const releasePage = await releases.json();
    expect(releasePage.template).toEqual({ scope: 'route', key: 'releases' });
    expect(releasePage.reads).toEqual({});

    await userEvent.click(await view.findByRole('link', { name: /visual novels/i }));
    await view.findByRole('heading', { name: 'Visual novels' });
  },
};

export const ReadyEmpty: Story = {
  name: 'Ready · empty home',
  parameters: {
    docs: {
      description: {
        story: 'The home route is ready and empty. It does not imply a public roster or invented catalogue count.',
      },
    },
  },
  render: () => <PageStory visitor="Signed Out" path={routePath(visualNovelZoneIds.empty)} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    await within(canvasElement).findByText(/ready-empty preview shows no work rows/i);
    const response = await readZone(visualNovelZoneIds.empty);
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page.template).toEqual({ scope: 'route', key: '' });
    expect(page.reads).toEqual({});
  },
};

export const SparseHome: Story = {
  name: 'Ready · sparse home',
  parameters: {
    docs: {
      description: {
        story:
          'A sparse authored preview with fictional copy. Its example is not a semantic result or a release claim.',
      },
    },
  },
  render: () => <PageStory visitor="Signed Out" path={routePath(visualNovelZoneIds.sparse)} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    await within(canvasElement).findByText(/Cartographer of Small Fires/);
    const response = await readZone(visualNovelZoneIds.sparse);
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page.template).toEqual({ scope: 'route', key: '' });
    expect(page.reads).toEqual({});
  },
};

export const Releases: Story = {
  name: 'Static route · releases',
  parameters: {
    docs: {
      description: {
        story:
          'The configured releases route stays static and has no release read, publication dates, or producer roster.',
      },
    },
  },
  render: () => <PageStory visitor="Signed Out" path={routePath(visualNovelZoneIds.preview, 'releases')} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    await within(canvasElement).findByText(/no release feed, publication dates, or producer roster/i);
    const response = await readZone(visualNovelZoneIds.preview, 'releases');
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page.template).toEqual({ scope: 'route', key: 'releases' });
    expect(page.reads).toEqual({});
    await within(canvasElement).findByRole('link', { name: /visual novels/i });
  },
};

export const PlatformClosed: Story = {
  name: 'Gated · platform closed (403)',
  parameters: {
    docs: { description: { story: 'The platform gate denies this candidate with platform_closed.' } },
  },
  render: () => <PageStory visitor="Signed Out" path={routePath(visualNovelZoneIds.closed)} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    await assertFailure(visualNovelZoneIds.closed, 403, 'platform_closed');
  },
};

export const SemanticUnavailable: Story = {
  name: 'Unavailable · semantic data not ready (503)',
  parameters: {
    docs: { description: { story: 'The semantic home read returns semantic_not_ready and Retry-After: 1.' } },
  },
  render: () => <PageStory visitor="Signed Out" path={routePath(visualNovelZoneIds.unavailable)} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    await assertFailure(visualNovelZoneIds.unavailable, 503, 'semantic_not_ready', '1');
    const releases = await readZone(visualNovelZoneIds.unavailable, 'releases');
    expect(releases.status).toBe(200);
    expect((await releases.json()).reads).toEqual({});
  },
};

export const PrivateZone: Story = {
  name: 'Concealed · private Zone (404)',
  parameters: {
    docs: {
      description: { story: 'Private visibility is concealed behind the same not-found response as a missing Zone.' },
    },
  },
  render: () => <PageStory visitor="Signed Out" path={routePath(visualNovelZoneIds.private)} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    await assertFailure(visualNovelZoneIds.private, 404, 'not_found');
  },
};

export const MissingZone: Story = {
  name: 'Concealed · missing Zone (404)',
  parameters: {
    docs: {
      description: { story: 'A missing Zone is concealed with the same not-found response as private visibility.' },
    },
  },
  render: () => <PageStory visitor="Signed Out" path={routePath(visualNovelZoneIds.missing)} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    await assertFailure(visualNovelZoneIds.missing, 404, 'not_found');
  },
};
