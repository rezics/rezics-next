import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { PAGE_GLOBAL_CONTEXT, planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { SubjectPage, pageContext, subjectPageTitle, type SubjectPageData } from '../features/pages/subject';
import { SubjectFrame, SubjectViewPage, subjectFrame } from '../features/pages/subject-frame';
import { subjectPageMessages, viewTabLabels } from '../features/pages/route-support';
import { subjectTabs } from '../features/pages/views';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { subjectHref } from '../subject/subject-href';
import recording from '../kernel/recorded/subject-page.json';
import realmRecording from '../kernel/recorded/realm.json';
import { PatternStory, pagePaths } from './page';

/** Constructed caller states reuse recorded subject values and delivered Realm metadata; they assert no grant. */
function reading(fallback = false): SubjectPageData {
  const page = structuredClone(recording) as unknown as SubjectPageData;
  page.requestedRealm = realmRecording.realm.realmId;
  page.context = fallback
    ? { id: PAGE_GLOBAL_CONTEXT, population: { kind: 'global' } }
    : {
        id: realmRecording.realm.contextId,
        population: { kind: 'realm', id: realmRecording.realm.realmId, title: realmRecording.realm.title },
      };
  for (const read of Object.values(page.reads)) {
    const body = read.body as { subject?: { context: string } };
    if (body.subject) body.subject.context = page.context.id;
  }
  return page;
}

function ContextPage({ fallback = false }: { fallback?: boolean }) {
  const page = reading(fallback);
  return (
    <SubjectPage
      page={page}
      locale={getLocale()}
      messages={subjectPageMessages()}
      tabs={subjectTabs(page)}
      tabLabels={viewTabLabels()}
      renderJsonLd={false}
    />
  );
}

function ContinuedGroup() {
  const overview = reading();
  const locale = getLocale();
  const frame = subjectFrame(overview, locale)!;
  const continuation = { node: 'editions', cursor: 'current-native-cursor' };
  const document: CompositionDocument = {
    root: { props: {} },
    content: [
      { type: 'SubjectList', props: { id: 'editions', property: 'schema:exampleOfWork', limit: 12, paged: true } },
      { type: 'SubjectList', props: { id: 'works', property: 'schema:author', limit: 12, paged: true } },
    ],
  };
  const page: SubjectPageData = { ...overview, document, continuation, reads: {} };
  const plan = planReads(platformRegistry, document, pageContext(page));
  page.reads[plan.nodes.editions!] = { status: 200, body: { links: [], next: 'next-native-cursor' } };
  page.reads[plan.nodes.works!] = { status: 204, body: {} };
  return (
    <SubjectViewPage
      page={page}
      subjectLabel={subjectPageTitle(overview, locale)}
      locale={locale}
      view="editions"
      label={m.subject_editions()}
      messages={subjectPageMessages()}
      renderJsonLd={false}
      frame={
        <SubjectFrame
          frame={frame}
          locale={locale}
          realm={page.requestedRealm}
          unlabelled={m.subject_value_unlabelled()}
          tabs={subjectTabs(overview)}
          tabLabels={viewTabLabels()}
          view="editions"
        />
      }
    />
  );
}

const meta = {
  title: 'Pages/Subjects/Context',
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <PatternStory visitor="Signed In" path={pagePaths.subject}>
        <AppShell>
          <Story />
        </AppShell>
      </PatternStory>
    ),
  ],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const SelectedRealm: Story = {
  render: () => <ContextPage />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const o = { locale: getLocale() };
    await expect(
      canvas.getByRole('link', { name: m.subject_context_return({ title: realmRecording.realm.title }, o) }),
    ).toHaveAttribute('href', `/${getLocale()}/realms/${realmRecording.realm.realmId}`);
    await expect(canvas.getByRole('link', { name: m.subject_context_switch_global({}, o) })).toHaveAttribute(
      'href',
      subjectHref({ id: recording.subject, label: subjectPageTitle(reading(), getLocale()) }, getLocale()).href,
    );
  },
};

export const GlobalFallback: Story = {
  render: () => <ContextPage fallback />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.subject_context_global())).toBeVisible();
    await expect(canvas.getByRole('link', { name: m.subject_context_retry() })).toHaveAttribute(
      'href',
      expect.stringContaining(`realm=${realmRecording.realm.realmId}`),
    );
    await expect(canvas.queryByText(realmRecording.realm.title)).toBeNull();
  },
};

export const IndependentContinuation: Story = {
  render: () => <ContinuedGroup />,
  play: async ({ canvasElement }) => {
    const continueLink = canvasElement.querySelector('[data-node="editions"] [data-slot="continue-group"]');
    await expect(continueLink).toHaveAttribute(
      'href',
      expect.stringContaining(`node=editions&cursor=next-native-cursor&realm=${realmRecording.realm.realmId}`),
    );
    await expect(within(canvasElement).getByRole('link', { name: m.subject_relation_restart() })).toHaveAttribute(
      'href',
      expect.stringContaining('node=works'),
    );
  },
};
