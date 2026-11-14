import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { PageStory, pageReady } from './page';
import {
  BOOK_CANDIDATE_SUBJECT_IDS,
  BOOK_CANDIDATE_ZONE_IDS,
  bookCandidatePreviewCopy,
} from '../zones/candidates/book';

const meta = {
  title: 'Zones/Candidates/Books',
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: `${bookCandidatePreviewCopy} The starter home is source-gated; Editions remains a static route with no edition list.`,
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function zonePath(zoneId: string, route = ''): string {
  return `/zones/${zoneId}${route ? `/${route}` : ''}`;
}

async function routeAndReturn({ canvasElement }: { canvasElement: HTMLElement }) {
  await pageReady({ canvasElement });
  await within(within(canvasElement).getByRole('main')).findByRole('heading', { name: 'Editions' });
  await within(within(canvasElement).getByRole('main')).findByText(/does not publish an edition list/i);

  await userEvent.click(await within(within(canvasElement).getByRole('main')).findByRole('link', { name: 'Books' }));
  await within(within(canvasElement).getByRole('main')).findByRole('heading', { name: 'Books' });
  await userEvent.click(await within(within(canvasElement).getByRole('main')).findByRole('link', { name: 'Editions' }));
  await within(within(canvasElement).getByRole('main')).findByRole('heading', { name: 'Editions' });
}

async function notFoundState({ canvasElement }: { canvasElement: HTMLElement }) {
  await pageReady({ canvasElement });
  const main = within(canvasElement).getByRole('main');
  await within(main).findByText(/not found/i);
  await expect(main).not.toHaveTextContent(/The Archive of Quiet Stars|The Mapmaker’s Winter/);
}

export const AdmittedFictionalPreview: Story = {
  name: 'Gated preview — admitted fictional source sample',
  parameters: {
    docs: {
      description: {
        story:
          'A synthetic admitted-source response for development preview only; it does not establish an official Books site or a public live catalogue.',
      },
    },
  },
  render: () => <PageStory visitor="Signed Out" path={zonePath(BOOK_CANDIDATE_ZONE_IDS.admitted)} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const main = within(canvasElement).getByRole('main');
    await within(main).findByRole('heading', { name: 'Books' });
    await within(main).findByRole('link', {
      name: 'The Archive of Quiet Stars',
    });
    await within(main).findByRole('link', { name: 'Salt Beneath the Orchard' });
    const winter = await within(main).findByRole('link', {
      name: 'The Mapmaker’s Winter',
    });
    const href = winter.getAttribute('href');
    const subjectPath = new URL(href ?? '', window.location.href).pathname;
    await expect(href).toMatch(new RegExp(`/subjects/${BOOK_CANDIDATE_SUBJECT_IDS.winter}(?:$|[?#])`));
    await expect(subjectPath).toMatch(new RegExp(`/subjects/${BOOK_CANDIDATE_SUBJECT_IDS.winter}$`));
    await expect(subjectPath).not.toContain(`/zones/${BOOK_CANDIDATE_ZONE_IDS.admitted}/subjects/`);

    await userEvent.click(winter);
    await within(canvasElement).findByRole('heading', { name: 'The Mapmaker’s Winter' });
    const subjectMain = within(canvasElement).getByRole('main');
    const returnLink = (await within(subjectMain).findAllByRole('link')).find((link) =>
      new URL(link.href, window.location.href).pathname.endsWith(`/zones/${BOOK_CANDIDATE_ZONE_IDS.admitted}`),
    );
    if (!returnLink) throw new Error('The canonical Subject page lost its Books Zone visit context.');
    await userEvent.click(returnLink);
    await within(canvasElement).findByRole('heading', { name: 'Books' });
  },
};

export const EditionsStaticRoute: Story = {
  name: 'Deferred static route — Editions, no read',
  parameters: {
    docs: {
      description: {
        story:
          'The configured Editions route uses its static document and an empty reads map. Its route navigation returns to Books.',
      },
    },
  },
  render: () => <PageStory visitor="Signed Out" path={zonePath(BOOK_CANDIDATE_ZONE_IDS.admitted, 'editions')} />,
  play: routeAndReturn,
};

export const ReadyEmpty: Story = {
  name: 'Gated preview — ready empty source',
  parameters: {
    docs: {
      description: {
        story:
          'The source read succeeds and returns no book works. The empty result is distinct from gate closure and owner unavailability.',
      },
    },
  },
  render: () => <PageStory visitor="Signed Out" path={zonePath(BOOK_CANDIDATE_ZONE_IDS.readyEmpty)} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const main = within(canvasElement).getByRole('main');
    await within(main).findByRole('heading', { name: 'Books' });
    await within(main).findByText(/source response is ready and has no matching book works/i);
  },
};

export const Sparse: Story = {
  name: 'Gated preview — sparse source',
  parameters: {
    docs: {
      description: {
        story:
          'One fictional Book work is returned with optional author, publication date and word-count facts absent.',
      },
    },
  },
  render: () => <PageStory visitor="Signed Out" path={zonePath(BOOK_CANDIDATE_ZONE_IDS.sparse)} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const main = within(canvasElement).getByRole('main');
    await within(main).findByRole('heading', { name: 'Books' });
    await within(main).findByText(/one fictional book work with no author, publication date or word count recorded/i);
    await within(main).findByRole('link', { name: 'The Mapmaker’s Winter' });
  },
};

export const PlatformClosed: Story = {
  name: 'Gated preview — platform closed, 403',
  parameters: {
    docs: {
      description: {
        story:
          'The source-dependent home is denied by the platform gate with 403 platform_closed; it is not an empty list.',
      },
    },
  },
  render: () => <PageStory visitor="Signed Out" path={zonePath(BOOK_CANDIDATE_ZONE_IDS.platformClosed)} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const main = within(canvasElement).getByRole('main');
    await within(main).findByText(/platform_closed/i);
    await expect(main).not.toHaveTextContent(/The Archive of Quiet Stars|The Mapmaker’s Winter/);
  },
};

export const SemanticNotReady: Story = {
  name: 'Gated preview — semantic not ready, 503',
  parameters: {
    docs: {
      description: {
        story:
          'The source owner is unavailable: 503 semantic_not_ready with Retry-After: 1, distinct from a ready empty response.',
      },
    },
  },
  render: () => <PageStory visitor="Signed Out" path={zonePath(BOOK_CANDIDATE_ZONE_IDS.semanticNotReady)} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const main = within(canvasElement).getByRole('main');
    await within(main).findByText(/semantic_not_ready/i);
    await within(main).findByText(/not ready yet/i);
    await expect(main).not.toHaveTextContent(/The Archive of Quiet Stars|The Mapmaker’s Winter/);
  },
};

export const PrivateConcealed: Story = {
  name: 'Gated preview — concealed private Zone, 404',
  parameters: {
    docs: {
      description: {
        story:
          'An unreadable private Zone returns the same concealed 404 as a missing Zone and discloses no shell or book content.',
      },
    },
  },
  render: () => <PageStory visitor="Signed Out" path={zonePath(BOOK_CANDIDATE_ZONE_IDS.private)} />,
  play: notFoundState,
};

export const MissingConcealed: Story = {
  name: 'Gated preview — concealed missing Zone, 404',
  parameters: {
    docs: {
      description: {
        story:
          'A missing Zone returns the same concealed 404 as an unreadable private Zone and discloses no shell or book content.',
      },
    },
  },
  render: () => <PageStory visitor="Signed Out" path={zonePath(BOOK_CANDIDATE_ZONE_IDS.missing)} />,
  play: notFoundState,
};
