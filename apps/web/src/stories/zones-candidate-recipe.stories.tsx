import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { PageStory, type PageStoryContext } from './page';
import { RECIPE_PREVIEW_LABEL, RECIPE_SUBJECT_IDS, RECIPE_ZONE_IDS } from '../zones/candidates/recipe';

const meta = {
  title: 'Zones/Candidates/Recipes',
  parameters: {
    docs: {
      description: {
        component:
          'A fictional Recipes candidate shown as a gated development preview, deferred for real source admission. These stories do not claim an official site, live catalogue, or native source readiness.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

let activePage: PageStoryContext | undefined;

function CandidatePage({ path }: { path: string }) {
  return (
    <PageStory
      visitor="Signed Out"
      path={path}
      onReady={(context) => {
        activePage = context;
        return () => {
          if (activePage === context) activePage = undefined;
        };
      }}
    />
  );
}

const zonePath = (state: keyof typeof RECIPE_ZONE_IDS) => `/zones/${RECIPE_ZONE_IDS[state]}`;
const recipePath = (state: 'admitted' | 'sparse', subject: string) => `${zonePath(state)}/subjects/${subject}`;

async function expectCopy(canvasElement: HTMLElement, copy: RegExp) {
  await within(canvasElement).findByText(copy);
}

const detailReturn: Story['play'] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await canvas.findByText(RECIPE_PREVIEW_LABEL);
  const recipeLink = await canvas.findByRole('link', {
    name: /Apricot Window-Pan Toast/,
  });
  recipeLink.focus();
  await userEvent.keyboard('{Enter}');

  await waitFor(() => {
    expect(
      activePage?.router.state.location.pathname.endsWith(
        `/zones/${RECIPE_ZONE_IDS.admitted}/subjects/${RECIPE_SUBJECT_IDS.apricotToast}`,
      ),
    ).toBe(true);
  });
  await canvas.findByRole('heading', { name: 'Apricot Window-Pan Toast' });
  activePage?.router.history.back();
  await waitFor(() =>
    expect(activePage?.router.state.location.pathname.endsWith(`/zones/${RECIPE_ZONE_IDS.admitted}`)).toBe(true),
  );
  await canvas.findByText(RECIPE_PREVIEW_LABEL);
};

export const AdmittedPreview: Story = {
  name: 'Candidate · admitted gated preview · deferred',
  render: () => <CandidatePage path={zonePath('admitted')} />,
  parameters: {
    docs: {
      description: {
        story: 'A clearly labelled, deferred candidate preview with fictional, typed Recipe rows.',
      },
    },
  },
  play: detailReturn,
};

export const ReadyEmpty: Story = {
  name: 'Candidate · ready empty · gated preview · deferred',
  render: () => <CandidatePage path={zonePath('empty')} />,
  parameters: {
    docs: {
      description: {
        story: 'The candidate read succeeds and returns no matching Recipe rows; real source admission is deferred.',
      },
    },
  },
  play: async ({ canvasElement }) => expectCopy(canvasElement, /ready and has no matching recipes/i),
};

export const SparseHome: Story = {
  name: 'Candidate · sparse gated preview · deferred',
  render: () => <CandidatePage path={zonePath('sparse')} />,
  parameters: {
    docs: {
      description: {
        story: 'One fictional Recipe is present with optional facts absent; this gated candidate preview is deferred.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(/optional facts absent/i);
    await canvas.findByRole('link', { name: /Rain-on-the-Window Porridge/ });
  },
};

export const PlatformClosed: Story = {
  name: 'Candidate · platform closed 403 · gated preview · deferred',
  render: () => <CandidatePage path={zonePath('closed')} />,
  parameters: {
    docs: {
      description: {
        story:
          'This fictional candidate preview remains gated and deferred because source access is closed: platform_closed.',
      },
    },
  },
  play: async ({ canvasElement }) => expectCopy(canvasElement, /platform_closed/i),
};

export const SourcesUnavailable: Story = {
  name: 'Candidate · semantic unavailable 503 · gated preview · deferred',
  render: () => <CandidatePage path={zonePath('unavailable')} />,
  parameters: {
    docs: {
      description: {
        story:
          'This fictional candidate preview remains gated and deferred while its source owner is unavailable: semantic_not_ready, with Retry-After: 1.',
      },
    },
  },
  play: async ({ canvasElement }) => expectCopy(canvasElement, /semantic_not_ready/i),
};

export const PrivateCandidate: Story = {
  name: 'Candidate · private concealed 404 · gated preview · deferred',
  render: () => <CandidatePage path={zonePath('private')} />,
  parameters: {
    docs: {
      description: {
        story: 'A private, fictional candidate is gated and deferred, and is indistinguishable from a missing page.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('This page is not available.');
    expect(canvas.queryByRole('heading', { name: 'Recipes' })).not.toBeInTheDocument();
  },
};

export const MissingCandidate: Story = {
  name: 'Candidate · missing concealed 404 · gated preview · deferred',
  render: () => <CandidatePage path={zonePath('missing')} />,
  parameters: {
    docs: {
      description: {
        story:
          'A nonexistent gated candidate uses the same concealed 404 response as a private one; real source admission is deferred.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('This page is not available.');
    expect(canvas.queryByRole('heading', { name: 'Recipes' })).not.toBeInTheDocument();
  },
};

export const RecipeDetail: Story = {
  name: 'Candidate · recipe detail · gated preview · deferred',
  render: () => <CandidatePage path={recipePath('admitted', RECIPE_SUBJECT_IDS.apricotToast)} />,
  parameters: {
    docs: {
      description: {
        story:
          'A fictional recipe row resolves to its matching synthetic Subject through the Zone read route in this gated, deferred candidate preview.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: 'Apricot Window-Pan Toast' });
    await canvas.findByText(/warm the apricots cut-side down/i);
  },
};
