import type { Meta, StoryObj } from '@storybook/react-vite';
import { PAGE_GLOBAL_CONTEXT, pickText } from '@rezics/composition';
import { useMemo, useState } from 'react';
import { CandidateReaderBoundary } from '../subject/candidate-lifetime';
import { Button } from '@rezics/ui/shadcn/button';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { StoryArcProfile } from '../features/catalogue/story-arc-profile-view';
import { StoryArcProfileContextNotice } from '../features/catalogue/story-arc-profile-view';
import { storyArcPublicOrigin, storyArcGlobalChoiceHref } from '../features/catalogue/story-arc-public-visit';
import { storyArcProperty } from '../features/catalogue/story-arc-profile';
import {
  storyArcProfileFixture,
  storyArcProfileId,
  storyArcCreatedId,
  type StoryArcScenario,
} from '../kernel/fake/catalogue-story-arc-profile';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { subjectHref } from '../subject/subject-href';
import { PageStory, PatternStory } from './page';

function Example({
  scenario = 'ready',
  existing = false,
  work = false,
  workLabel = 'supplied',
  retirement = false,
  publicOrigin = false,
}: {
  scenario?: StoryArcScenario;
  existing?: boolean;
  work?: boolean;
  workLabel?: 'supplied' | 'long' | 'absent';
  retirement?: boolean;
  publicOrigin?: boolean;
}) {
  const locale = getLocale();
  const [retired, setRetired] = useState(false);
  const fixture = useMemo(() => {
    const current = storyArcProfileFixture(scenario, locale);
    if (workLabel === 'long')
      current.work.publicRead.subject.labels = {
        ja: '星を渡る旅人たちの物語 — Die Reise durch die Sternenstadt — '.repeat(8),
      };
    if (workLabel === 'absent') current.work.publicRead.subject.labels = {};
    return current;
  }, [scenario, locale, workLabel]);
  const transport = useMemo(
    () => ({
      ...fixture.transport,
      load: retired ? async () => ({ ok: false as const, reason: 'denied' as const }) : fixture.transport.load,
    }),
    [fixture, retired],
  );
  const origin = publicOrigin
    ? storyArcPublicOrigin({
        currentHref: subjectHref({ id: storyArcProfileId, label: 'A named arc' }, locale).href,
        id: storyArcProfileId,
        locale,
      })
    : undefined;
  const profile = (
    <StoryArcProfile
      key={`${scenario}:${existing}:${work}:${locale}`}
      locale={locale}
      {...fixture.props}
      {...(publicOrigin
        ? { context: PAGE_GLOBAL_CONTEXT, definition: 'sha256:story-arc-current', ...(origin ? { via: origin } : {}) }
        : {})}
      transport={transport}
      {...(retired ? { session: 'signed-out' as const } : {})}
      {...(existing ? { id: storyArcProfileId } : {})}
      {...(work ? { work: fixture.work.id } : {})}
    />
  );
  return (
    <PatternStory visitor={scenario === 'signed-out' ? 'Signed Out' : 'Signed In'}>
      <AppShell>
        {retirement ? (
          <>
            <Button data-fixture-retire onClick={() => setRetired(true)} disabled={retired}>
              Retire the illustrative current reader
            </Button>
            <CandidateReaderBoundary
              address="fictional-work-story"
              observed={{
                state: retired ? 'signed-out' : 'signed-in',
                subject: retired ? null : 'story-reader',
                csrfToken: retired ? null : 'story-csrf',
              }}
            >
              {profile}
            </CandidateReaderBoundary>
          </>
        ) : (
          profile
        )}
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Catalogue/Narrative story-arc editor',
  id: 'pages-catalogue-narrative-story-arc-editor',
  component: Example,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1440: { name: 'Desktop 1440', styles: { width: '1440px', height: '900px' } },
      },
    },
    docs: {
      description: {
        component:
          'Create an arc under one task heading with read-only released Type metadata, or choose an existing arc. Synthetic native-shaped responses use production creation, scalar and relation adapters. Review the outer visit states at phone390 and desktop1440 across all eight locales and both themes with the Storybook globals. Web visual review and integrated native bindings remain pending.',
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

async function assertCallerTarget(target: HTMLElement, container: HTMLElement, view: Window, phoneOrCoarse: boolean) {
  const bounds = container.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  await expect(target).toBeVisible();
  await expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 1);
  await expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
  await expect(target.scrollWidth).toBeLessThanOrEqual(target.clientWidth + 1);
  await expect(target.scrollHeight).toBeLessThanOrEqual(target.clientHeight + 1);
  if (phoneOrCoarse) {
    await expect(rect.height).toBeGreaterThanOrEqual(44);
    await expect(rect.width).toBeGreaterThanOrEqual(44);
  } else {
    await expect(rect.height).toBeLessThan(44);
  }
}

export const RouteEntry: Story = { render: () => <PageStory visitor="Signed In" path="/catalogue/story-arc" /> };
export const Create: Story = {};
export const CurrentArc: Story = { args: { existing: true } };
export const PublicGlobalOrigin: Story = {
  args: { existing: true, publicOrigin: true },
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('link', { name: m.story_arc_return_public() })).toBeVisible();
  },
};
function UnsupportedOriginExample() {
  const locale = getLocale();
  const subject = subjectHref({ id: storyArcProfileId, label: 'A named arc' }, locale);
  const via = storyArcPublicOrigin({
    currentHref: `${subject.href}?realm=5d0a0000-0000-4000-8000-000000000005`,
    id: storyArcProfileId,
    locale,
    realm: '5d0a0000-0000-4000-8000-000000000005',
  })!;
  return (
    <PatternStory visitor="Signed In">
      <AppShell>
        <StoryArcProfileContextNotice
          locale={locale}
          via={via}
          globalChoiceHref={storyArcGlobalChoiceHref({
            id: storyArcProfileId,
            slug: subject.params.slug,
            locale,
            via,
          })}
        />
      </AppShell>
    </PatternStory>
  );
}
export const UnsupportedPublicContext: Story = {
  render: () => <UnsupportedOriginExample />,
  globals: { viewport: { value: 'desktop1440', isRotated: false } },
};
export const WorkOrder: Story = {
  args: { existing: true, work: true },
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const article = canvas.getByRole('article');
    const view = canvasElement.ownerDocument.defaultView;
    if (!view) throw new Error('Story Arc profile story requires a browser window.');
    const phoneOrCoarse =
      canvasElement.ownerDocument.documentElement.clientWidth < 768 || view.matchMedia('(pointer: coarse)').matches;
    const publicProfile = canvas.getByRole('link', { name: m.candidate_view_public() });
    const reload = canvas.getByRole('button', { name: m.correction_reload() });
    const identity = within(canvas.getByRole('navigation', { name: m.facts_other_editors() }));
    const terms = identity.getByRole('link', { name: m.catalogue_terms_title() });
    const context = identity.getByRole('link', { name: m.context_title() });
    const relations = canvas.getByRole('link', { name: m.relation_title() });
    const work = within(canvas.getByRole('region', { name: m.story_arc_work() })).getByRole('link');
    const callerActions = [publicProfile, reload, terms, context, relations, work];
    for (const action of callerActions) await assertCallerTarget(action, article, view, phoneOrCoarse);

    publicProfile.focus();
    await userEvent.tab();
    await expect(reload).toHaveFocus();
    await expect(view.getComputedStyle(reload).outlineWidth).not.toBe('0px');
    await userEvent.tab();
    await expect(terms).toHaveFocus();
    await expect(view.getComputedStyle(terms).outlineWidth).not.toBe('0px');
    await reviewSlot(canvasElement);
  },
};

async function create(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.type(await canvas.findByRole('textbox', { name: m.catalogue_create_label() }), 'A real arc');
  await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
  return canvas;
}
export const Created: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = await create(canvasElement);
    const link = await canvas.findByRole('link', { name: m.catalogue_create_open() });
    expect(link.getAttribute('href')).toContain(`/subjects/${storyArcCreatedId}/a-real-arc`);
    const continueLink = await canvas.findByRole('link', { name: m.story_arc_continue() });
    await expect(continueLink).toBeVisible();

    const article = canvas.getByRole('article');
    const view = canvasElement.ownerDocument.defaultView;
    if (!view) throw new Error('Story Arc profile story requires a browser window.');
    const phoneOrCoarse =
      canvasElement.ownerDocument.documentElement.clientWidth < 768 || view.matchMedia('(pointer: coarse)').matches;
    const reload = canvas.getByRole('button', { name: m.correction_reload() });
    const existing = canvas.getByRole('textbox', { name: m.story_arc_choose_existing() });
    const work = canvas.getByRole('textbox', { name: m.story_arc_choose_work() });
    for (const action of [reload, existing, work, continueLink])
      await assertCallerTarget(action, article, view, phoneOrCoarse);

    reload.focus();
    await userEvent.tab();
    await expect(existing).toHaveFocus();
    const inputGroup = existing.closest<HTMLElement>('[data-slot="input-group"]');
    if (!inputGroup) throw new Error('Story Arc existing-subject picker has no focus ring container.');
    await expect(view.getComputedStyle(inputGroup).boxShadow).not.toBe('none');
  },
};
export const UncertainRetry: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = await create(canvasElement);
    const retry = await canvas.findByRole('button', { name: m.catalogue_create_retry() });
    expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toBeDisabled();
    await userEvent.click(retry);
    await expect(canvas.findByRole('link', { name: m.story_arc_continue() })).resolves.toBeVisible();
  },
};

async function editKeywords(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const name = pickText(storyArcProfileFixture().release.properties['schema:keywords']!.labels, getLocale()).text;
  const field = within(await canvas.findByRole('region', { name }));
  await userEvent.click(field.getByRole('button', { name: m.facts_edit_field() }));
  const value = field.getByRole('textbox', { name: m.correction_value() });
  await userEvent.clear(value);
  await userEvent.type(value, 'A corrected theme');
  return { canvas, field };
}
export const Proposed: Story = {
  args: { existing: true },
  play: async ({ canvasElement }) => {
    const { canvas, field } = await editKeywords(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.facts_submit() }));
    await expect(field.findByText(m.correction_proposed())).resolves.toBeVisible();
    expect(field.getByRole('link', { name: m.correction_review() }).getAttribute('href')).toContain('candidate=');
  },
};
export const PartialResults: Story = {
  args: { scenario: 'partial', existing: true },
  play: async ({ canvasElement }) => {
    const { canvas, field } = await editKeywords(canvasElement);
    const name = pickText(storyArcProfileFixture().release.properties['schema:url']!.labels, getLocale()).text;
    const url = within(canvas.getByRole('region', { name }));
    await userEvent.click(url.getByRole('button', { name: m.facts_edit_field() }));
    await userEvent.type(url.getByRole('textbox', { name: m.correction_value() }), 'https://example.org/arc');
    await userEvent.click(canvas.getByRole('button', { name: m.facts_submit() }));
    await expect(field.findByText(m.correction_proposed())).resolves.toBeVisible();
    await expect(url.findByText(m.correction_denied())).resolves.toBeVisible();
  },
};

async function reviewSlot(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const work = within(await canvas.findByRole('region', { name: m.story_arc_work() }));
  await userEvent.click(work.getByRole('button', { name: m.relation_open() }));
  await userEvent.selectOptions(await work.findByRole('combobox', { name: m.relation_property() }), storyArcProperty);
  await userEvent.click(work.getAllByRole('button', { name: m.relation_edit_existing() })[0]!);
  await userEvent.click(work.getByRole('button', { name: m.relation_review_slot() }));
  await expect(work.findByRole('button', { name: m.candidate_review() })).resolves.toBeVisible();
  return work;
}
async function confirm(work: ReturnType<typeof within>, action: string) {
  await userEvent.click(work.getByRole('button', { name: action }));
  const group = within(work.getByRole('group', { name: m.candidate_confirm_title({ action }) }));
  await userEvent.click(group.getByRole('button', { name: action }));
}
async function adopt(canvasElement: HTMLElement) {
  const work = await reviewSlot(canvasElement);
  await userEvent.click(work.getByRole('button', { name: m.candidate_review() }));
  await confirm(work, m.candidate_accept());
  await expect(work.findByText(m.candidate_accepted())).resolves.toBeVisible();
  await userEvent.click(work.getByRole('button', { name: m.candidate_reload() }));
  await userEvent.click(await work.findByRole('button', { name: m.candidate_review() }));
  await userEvent.selectOptions(work.getByRole('combobox', { name: m.relation_rank() }), 'preferred');
  await confirm(work, m.candidate_adopt());
  return work;
}
export const Selected: Story = {
  args: { existing: true, work: true },
  play: async ({ canvasElement }) => {
    const work = await adopt(canvasElement);
    await expect(work.findByText(m.candidate_selected())).resolves.toBeVisible();
  },
};
export const PendingSelection: Story = {
  args: { scenario: 'pending', existing: true, work: true },
  play: async ({ canvasElement }) => {
    const work = await adopt(canvasElement);
    await expect(work.findByText(m.candidate_pending())).resolves.toBeVisible();
  },
};
export const Invalid: Story = {
  args: { scenario: 'invalid' },
  play: async ({ canvasElement }) => {
    await create(canvasElement);
  },
};
export const Conflict: Story = {
  args: { scenario: 'conflict' },
  play: async ({ canvasElement }) => {
    await create(canvasElement);
  },
};
export const Saving: Story = {
  args: { scenario: 'saving' },
  play: async ({ canvasElement }) => {
    await create(canvasElement);
  },
};
export const ReaderUnavailable: Story = {
  args: { scenario: 'reader-unavailable' },
  play: async ({ canvasElement }) => {
    await create(canvasElement);
  },
};
export const ConcealedReader: Story = {
  args: { scenario: 'concealed' },
  play: async ({ canvasElement }) => {
    await create(canvasElement);
  },
};
export const Loading: Story = { args: { scenario: 'loading' } };
export const SignedOut: Story = { args: { scenario: 'signed-out', existing: true } };
export const Denied: Story = { args: { scenario: 'denied', existing: true } };
export const Unavailable: Story = { args: { scenario: 'unavailable' } };
export const StaleMetadata: Story = { args: { scenario: 'stale' } };
export const WrongGrain: Story = { args: { scenario: 'wrong-type', existing: true } };

// Illustrative production compositions only. All added play assertions are authored UNRUN.
export const LongWorkReference: Story = {
  args: { existing: true, work: true, workLabel: 'long' },
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('button', { name: m.fictional_work_choose_another() });
    const reference = canvasElement.querySelector<HTMLElement>('[data-slot="fictional-work-reference"]')!;
    const title = within(reference).getByRole('link');
    await expect(title.getAttribute('lang')).toBe(getLocale() === 'ja' ? null : 'ja');
    title.focus();
    await userEvent.tab();
    const summary = reference.querySelector('summary')!;
    await expect(summary).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(reference.querySelector('details')).toHaveAttribute('open');
    for (const text of reference.querySelectorAll<HTMLElement>('a, code')) {
      await expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth + 1);
    }
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth + 1);
  },
};
export const UnlabelledWork: Story = { args: { existing: true, work: true, workLabel: 'absent' } };
export const AnonymousWork: Story = { args: { scenario: 'signed-out', existing: true, work: true } };
export const UnavailableWork: Story = { args: { scenario: 'unavailable', existing: true, work: true } };
export const WorkSelection: Story = {
  args: { existing: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = await canvas.findByRole('textbox', { name: m.story_arc_choose_work() });
    await userEvent.type(input, storyArcProfileFixture().work.publicRead.subject.labels.en!);
    await screen.findByRole('option');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await expect(canvas.findByRole('button', { name: m.fictional_work_choose_another() })).resolves.toBeVisible();
  },
};
export const ClearedWork: Story = {
  args: { existing: true, work: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.fictional_work_choose_another() }));
    await expect(canvas.findByRole('textbox', { name: m.story_arc_choose_work() })).resolves.toBeVisible();
    await expect(canvas.queryByRole('button', { name: m.fictional_work_choose_another() })).toBeNull();
  },
};
export const RetiredWork: Story = {
  args: { existing: true, work: true, retirement: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('button', { name: m.fictional_work_choose_another() });
    await userEvent.click(canvasElement.querySelector<HTMLButtonElement>('[data-fixture-retire]')!);
    await waitFor(() => expect(canvasElement.querySelector('[data-slot="fictional-work-reference"]')).toBeNull());
    await expect(canvasElement.textContent).not.toContain(storyArcProfileFixture().work.id);
  },
};
