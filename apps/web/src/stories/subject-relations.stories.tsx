import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { pageContext, type SubjectPageData } from '../features/pages/subject';
import subjectRecording from '../kernel/recorded/subject.json';
import { PageStory, pageReady } from './page';
import { subjectViewHref } from '../subject/subject-href';

const meta = { title: 'Pages/Subjects/Subject Relations', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const path = subjectViewHref(
  { id: subjectRecording.subject.id, label: subjectRecording.subject.labels.en ?? 'Subject' },
  'en',
  'relations',
).replace(/^\/en/, '');

export const SignedIn: Story = {
  name: 'Signed In',
  play: pageReady,
  render: () => <PageStory visitor="Signed In" path={path} />,
};
export const SignedOut: Story = {
  name: 'Signed Out',
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={path} />,
};

/** Simulated pages on the actual default composition; these fixtures make no native authority claim. */
function continuationFixture() {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input instanceof Request ? input.clone() : input, init);
    const url = new URL(request.url);
    if (url.origin !== 'http://kernel.local' || url.pathname !== '/v1/pages:read' || request.method !== 'POST')
      return original(input, init);
    const supplied = (await request.clone().json()) as {
      target?: { subject?: string; view?: string };
      continuation?: { node: string; cursor: string };
    };
    const response = await original(input, init);
    if (
      supplied.target?.subject !== subjectRecording.subject.id ||
      (supplied.target.view !== undefined && !['overview', 'relations'].includes(supplied.target.view)) ||
      !response.ok
    )
      return response;
    const page = (await response.json()) as SubjectPageData;
    const plan = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page));
    for (const node of ['side-stories', 'adaptations']) {
      const key = plan.nodes[node];
      const read = key && plan.reads[key];
      if (!key || !read || read.kind !== 'links') throw new Error(`Expected the default ${node} relation stream.`);
      if (supplied.continuation && supplied.continuation.node !== node) continue;
      const later = supplied.continuation?.cursor === 'accessible-next';
      const last = supplied.continuation?.cursor === 'accessible-end';
      const row = (added: boolean) => ({
        subject: `0192f3a0-6c1e-7b2a-9d4e-${node === 'side-stories' ? '111' : '222'}00000000${added ? '2' : '1'}`,
        label: `${node === 'side-stories' ? 'Side story' : 'Adaptation'} ${added ? 'added' : 'first'}`,
        type: 'schema:Book',
        property: read.property,
      });
      page.reads[key] = {
        status: 200,
        body: {
          // A hidden row and repeated holders must not inflate the visible completion count.
          links:
            node === 'adaptations' && supplied.continuation
              ? []
              : later
                ? [row(false), row(true), row(true), { subject: 'withheld', label: 'Withheld title', summary: null }]
                : last
                  ? [row(true)]
                  : [row(false)],
          next: last ? null : later ? 'accessible-end' : 'accessible-next',
        },
      };
    }
    return Response.json(page, { status: response.status, headers: response.headers });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function continueSideStories(context: { canvasElement: HTMLElement }, exhausted = false) {
  await pageReady(context);
  const stream = context.canvasElement.querySelector<HTMLElement>('[data-node="side-stories"]');
  if (!stream) throw new Error('Expected the default side-stories stream.');
  const more = stream.querySelector<HTMLAnchorElement>('[data-slot="continue-group"]');
  if (!more) throw new Error('Expected a native continuation anchor.');
  more.focus();
  await userEvent.keyboard('{Enter}');
  await within(stream).findByRole('link', { name: 'Side story added' });
  await waitFor(() => expect(more).toHaveAttribute('aria-disabled', 'false'));
  await expect(more).toHaveFocus();
  if (exhausted) {
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(stream.querySelector('[data-slot="continue-group"]')).toBeNull());
    await expect(stream.querySelector('[data-slot="relation-stream-end"]')).toHaveFocus();
  }
}

export const Continuation: Story = {
  name: 'Continuation available',
  beforeEach: continuationFixture,
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={path} />,
};
export const Continued: Story = {
  name: 'Continued',
  beforeEach: continuationFixture,
  play: (context) => continueSideStories(context),
  render: () => <PageStory visitor="Signed Out" path={path} />,
};
export const Exhausted: Story = {
  name: 'Exhausted',
  beforeEach: continuationFixture,
  play: (context) => continueSideStories(context, true),
  render: () => <PageStory visitor="Signed Out" path={path} />,
};
