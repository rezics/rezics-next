import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useMemo, useState } from 'react';
import { pickText } from '@rezics/composition';
import { PeopleProfileEditor } from '../features/catalogue/people-profile-view';
import { RelationEditor } from '../features/catalogue/relation-editor';
import { relationFields } from '../subject/relation-candidates';
import {
  peopleProfileFixture,
  peopleCreatedId,
  peoplePersonId,
  peopleOrganizationId,
  peopleWorkId,
  selectPeopleProfileStory,
  type PeopleScenario,
  type PeopleMode,
} from '../kernel/fake/catalogue-people-profile';
import definitions from '../kernel/recorded/definitions-release.json';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { PageStory, PatternStory } from './page';
import { CandidateReaderBoundary } from '../subject/candidate-lifetime';

const longPerson = `Mira 佐藤 미라 米拉 ميرا ${'PersonneSansEspaces'.repeat(12)}`;
const longWork = `Lantern Songs 灯籠の歌 등불의노래 燈籠之歌 ${'WerkOhneLeerzeichen'.repeat(12)}`;
type WorkReference = 'long' | 'missing' | 'no-credit' | 'reload-failure';

function ProfileStory({
  scenario = 'ready',
  mode = 'create',
  signedOut = false,
  session = 'signed-in',
  reference,
}: {
  scenario?: PeopleScenario;
  mode?: PeopleMode;
  signedOut?: boolean;
  session?: 'signed-in' | 'signed-out' | 'unknown' | 'unavailable';
  reference?: WorkReference;
}) {
  const locale = getLocale();
  const fixture = useMemo(() => {
    const fixture = peopleProfileFixture(scenario, locale, mode);
    if (reference === 'long') {
      fixture.current.subject.labels = { en: longPerson, ja: longPerson, ko: longPerson, 'zh-Hant': longPerson };
      fixture.work.subject.labels = { en: longWork, ja: longWork, ko: longWork, 'zh-Hant': longWork };
    }
    // Explicit illustrative response variations over the existing fixture; no native proof.
    const load = fixture.transport.load;
    let reads = 0;
    fixture.transport = {
      ...fixture.transport,
      load: async () => {
        if (reference === 'reload-failure' && reads++ > 0) return { ok: false, reason: 'unavailable' };
        const read = await load();
        return read.ok
          ? {
              ...read,
              ...(reference === 'missing' ? { work: null } : {}),
              ...(reference === 'no-credit' ? { credits: [] } : {}),
            }
          : read;
      },
    };
    return fixture;
  }, [scenario, locale, mode, reference]);
  return (
    <PatternStory visitor={signedOut || session === 'signed-out' ? 'Signed Out' : 'Signed In'} path="/catalogue/people">
      <AppShell>
        <PeopleProfileEditor
          locale={locale}
          {...(mode !== 'create' ? { id: fixture.id } : {})}
          session={signedOut ? 'signed-out' : session}
          transport={fixture.transport}
          propose={fixture.propose}
          review={fixture.review}
          onNavigate={() => {}}
          relations={
            mode !== 'create' ? (
              <RelationEditor
                id={fixture.id}
                locale={locale}
                initial={{
                  ok: true,
                  public: fixture.current,
                  fields: relationFields(fixture.release, fixture.current.subject.type, locale),
                  names: Object.fromEntries(
                    Object.entries(fixture.release.properties).map(([id, property]) => [id, property.labels]),
                  ),
                  page: null,
                }}
                search={async () => []}
                transport={{
                  read: async () => ({ ok: false, reason: 'unavailable' }),
                  propose: async () => ({ ok: false, reason: 'unavailable' }),
                  confirm: async () => ({ ok: false, reason: 'unavailable' }),
                }}
              />
            ) : undefined
          }
        />
      </AppShell>
    </PatternStory>
  );
}

function ProfileRoute({ mode }: { mode: PeopleMode }) {
  const locale = getLocale();
  useMemo(() => selectPeopleProfileStory('ready', locale, mode), [locale, mode]);
  const path =
    mode === 'create'
      ? '/catalogue/people'
      : mode === 'person'
        ? `/subjects/${peoplePersonId}/mira-sato/people`
        : `/subjects/${peopleOrganizationId}/paper-lantern-studio/people`;
  return <PageStory visitor="Signed In" path={path} />;
}

const meta = {
  title: 'Pages/Catalogue/Person and organization catalogue editor',
  component: ProfileStory,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
    docs: {
      description: {
        component:
          'Released Person and Organization metadata over the existing native request seams. Route stories enter the actual application. Connected stories exercise creation and correction; fixture interactions do not establish native or visual acceptance. Relationship mutations in connected previews are unavailable; real routes bind the shared native relation editor.',
      },
    },
  },
} satisfies Meta<typeof ProfileStory>;
export default meta;
type Story = StoryObj<typeof meta>;

const urlLabel = () => pickText(definitions.release.properties['schema:url'].labels, getLocale()).text;
async function fill(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.selectOptions(
    await canvas.findByRole('combobox', { name: m.catalogue_create_type() }),
    'schema:Organization',
  );
  const language = canvas.getByRole('textbox', { name: m.catalogue_create_language() });
  await userEvent.clear(language);
  await userEvent.type(language, 'en');
  await userEvent.type(canvas.getByRole('textbox', { name: m.catalogue_create_label() }), 'Paper Lantern Studio');
  await userEvent.click(canvas.getByRole('button', { name: m.people_profile_add_fact({ field: urlLabel() }) }));
  const fact = within(canvas.getByRole('group', { name: urlLabel() }));
  await userEvent.type(fact.getByRole('textbox', { name: m.correction_value() }), 'https://example.org/studio');
  await userEvent.type(fact.getByRole('textbox', { name: m.relation_citation() }), 'https://example.org/credits');
  return canvas;
}
async function assertPeopleTarget(target: HTMLElement, region: HTMLElement, canvasElement: HTMLElement) {
  const document = canvasElement.ownerDocument;
  const view = document.defaultView;
  if (!view) throw new Error('People profile story requires a browser window.');
  const touchLayout = document.documentElement.clientWidth < 768 || view.matchMedia('(pointer: coarse)').matches;
  const rect = target.getBoundingClientRect();
  const bounds = region.getBoundingClientRect();
  await expect(target).toBeVisible();
  await expect(rect.height).toBeGreaterThanOrEqual(touchLayout ? 44 : 32);
  if (touchLayout) await expect(rect.width).toBeGreaterThanOrEqual(44);
  else await expect(rect.height).toBeLessThan(44);
  await expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 1);
  await expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
  await expect(target.scrollWidth).toBeLessThanOrEqual(target.clientWidth + 1);
  await expect(target.scrollHeight).toBeLessThanOrEqual(target.clientHeight + 1);
}
async function fillAndAssertOwnedControls(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const main = canvas.getByRole('main');
  const credit = within(canvas.getByRole('heading', { name: m.people_profile_credit() }).closest('section')!);
  const work = credit.getByRole('link', { name: 'Lantern Songs' });
  const relations = credit.getByRole('link', { name: m.relation_title() });
  await expect(work.tagName).toBe('A');
  await expect(work).toHaveAttribute('href', expect.stringContaining(peopleWorkId));
  await expect(relations.tagName).toBe('A');
  await expect(relations).toHaveAttribute('href', expect.stringContaining('/relation-edit'));
  const creditSection = credit.getByRole('heading', { name: m.people_profile_credit() }).closest('section')!;
  await assertPeopleTarget(work, creditSection, canvasElement);
  await assertPeopleTarget(relations, creditSection, canvasElement);

  work.focus();
  await userEvent.tab();
  await expect(relations).toHaveFocus();
  const view = canvasElement.ownerDocument.defaultView!;
  const focusStyle = view.getComputedStyle(relations);
  await expect(focusStyle.outlineWidth !== '0px' || focusStyle.boxShadow !== 'none').toBe(true);

  await userEvent.selectOptions(
    await canvas.findByRole('combobox', { name: m.catalogue_create_type() }),
    'schema:Organization',
  );
  const language = canvas.getByRole('textbox', { name: m.catalogue_create_language() });
  await userEvent.clear(language);
  await userEvent.type(language, 'en');
  await userEvent.type(canvas.getByRole('textbox', { name: m.catalogue_create_label() }), 'Paper Lantern Studio');
  const add = canvas.getByRole('button', { name: m.people_profile_add_fact({ field: urlLabel() }) });
  await expect(add).toHaveAttribute('type', 'button');
  const initial = canvas.getByRole('heading', { name: m.people_profile_initial() }).closest('section')!;
  await assertPeopleTarget(add, initial, canvasElement);
  add.focus();
  await expect(add).toHaveFocus();
  const addFocusStyle = view.getComputedStyle(add);
  await expect(addFocusStyle.outlineWidth !== '0px' || addFocusStyle.boxShadow !== 'none').toBe(true);
  await userEvent.keyboard('{Enter}');

  const group = canvas.getByRole('group', { name: urlLabel() });
  const fact = within(group);
  const remove = fact.getByRole('button', { name: m.people_profile_remove_fact() });
  const citation = fact.getByRole('textbox', { name: m.relation_citation() });
  await expect(remove).toHaveAttribute('type', 'button');
  await expect(citation).toHaveAttribute('type', 'url');
  await assertPeopleTarget(remove, group, canvasElement);
  await assertPeopleTarget(citation, group, canvasElement);
  const value = fact.getByRole('textbox', { name: m.correction_value() });
  const longUrl = `https://example.org/${'studio-credit/'.repeat(8)}source`;
  await userEvent.type(value, longUrl);
  await userEvent.type(citation, longUrl);
  await expect(value).toHaveValue(longUrl);
  await expect(citation).toHaveValue(longUrl);
  await expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth + 1);
  return canvas;
}
async function submit(canvasElement: HTMLElement) {
  const canvas = await fill(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
  return canvas;
}
export const Create: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = await fillAndAssertOwnedControls(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
    await expect(await canvas.findByRole('link', { name: m.catalogue_create_open() })).toHaveAttribute(
      'href',
      `/${getLocale()}/subjects/${peopleCreatedId}/paper-lantern-studio`,
    );
    await expect(canvas.getByText(peopleCreatedId)).toBeVisible();
    await expect(canvas.findByRole('link', { name: m.relation_title() })).resolves.toBeVisible();
    await expect(canvasElement.querySelectorAll('main#main-content')).toHaveLength(1);
  },
};
export const Person: Story = { args: { mode: 'person' } };
export const Organization: Story = { args: { mode: 'organization' } };
export const CorrectCitedFact: Story = {
  args: { mode: 'person' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const field = within(await canvas.findByRole('region', { name: urlLabel() }));
    await userEvent.click(field.getByRole('button', { name: m.facts_edit_field() }));
    const input = field.getAllByRole('textbox', { name: m.correction_value() })[0]!;
    await userEvent.clear(input);
    await userEvent.type(input, 'https://example.org/corrected');
    await userEvent.click(canvas.getByRole('button', { name: m.facts_submit() }));
    await expect(await field.findByText(m.correction_proposed())).toBeVisible();
    await expect(field.getByRole('link', { name: 'https://example.org/original' })).toBeVisible();
    await userEvent.click(field.getByRole('link', { name: m.correction_review() }));
    const review = within(await canvas.findByRole('region', { name: m.candidate_title() }));
    const proposedHeading = await review.findByRole('heading', { name: m.candidate_proposed() });
    const currentHeading = await review.findByRole('heading', { name: m.candidate_current() });
    await expect(
      within(proposedHeading.parentElement!).getByRole('link', { name: 'https://example.org/corrected' }),
    ).toBeVisible();
    await expect(
      within(currentHeading.parentElement!).getByRole('link', { name: 'https://example.org/original' }),
    ).toBeVisible();
  },
};
export const Loading: Story = { args: { scenario: 'loading' } };
export const PersonLoading: Story = { args: { mode: 'person', scenario: 'loading' } };
export const OrganizationLoading: Story = { args: { mode: 'organization', scenario: 'loading' } };
export const Empty: Story = { args: { scenario: 'empty' } };
export const SignedOut: Story = { args: { signedOut: true } };
export const Denied: Story = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    await expect(await canvas.findByText(m.catalogue_create_denied())).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveValue('Paper Lantern Studio');
  },
};
export const Invalid: Story = {
  args: { scenario: 'invalid' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    await expect(await canvas.findByText(m.catalogue_create_invalid())).toBeVisible();
  },
};
export const StaleMetadata: Story = { args: { scenario: 'stale' } };
export const Unavailable: Story = { args: { scenario: 'unavailable' } };
export const UncertainSubmit: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    await expect(await canvas.findByText(m.catalogue_create_uncertain())).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toBeDisabled();
    await expect(
      within(canvas.getByRole('group', { name: urlLabel() })).getByRole('textbox', { name: m.correction_value() }),
    ).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_retry() }));
    await expect(await canvas.findByRole('link', { name: m.catalogue_create_open() })).toBeVisible();
  },
};
export const CreatedReadbackUnavailable: Story = {
  args: { scenario: 'reader-unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    await expect(await canvas.findByText(m.catalogue_create_reader_unavailable())).toBeVisible();
    await expect(canvas.getByText(peopleCreatedId)).toBeVisible();
  },
};
export const CreatedReadbackConcealed: Story = {
  args: { scenario: 'concealed' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    await expect(await canvas.findByText(m.catalogue_create_concealed())).toBeVisible();
  },
};
export const CreateRoute: Story = { render: () => <ProfileRoute mode="create" /> };
export const PersonRoute: Story = { render: () => <ProfileRoute mode="person" /> };
export const OrganizationRoute: Story = { render: () => <ProfileRoute mode="organization" /> };

// UNRUN: production-composed presentation fixtures, including browser geometry and keyboard assertions.
export const LongWorkReference: Story = {
  args: { reference: 'long' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const title = await canvas.findByRole('heading', { name: longWork, level: 3 });
    const frame = title.closest<HTMLElement>('[data-slot="profile-work-reference"]')!;
    const link = within(frame).getByRole('link', { name: longWork });
    const correction = within(frame).getByRole('link', { name: m.relation_title() });
    const view = canvasElement.ownerDocument.defaultView!;
    const touch = view.innerWidth < 768 || view.matchMedia('(pointer: coarse)').matches;
    const rect = link.getBoundingClientRect();
    await expect(rect.height).toBeGreaterThanOrEqual(touch ? 44 : 32);
    if (touch) await expect(rect.width).toBeGreaterThanOrEqual(44);
    await expect(rect.left).toBeGreaterThanOrEqual(frame.getBoundingClientRect().left - 1);
    await expect(rect.right).toBeLessThanOrEqual(frame.getBoundingClientRect().right + 1);
    await expect(link.scrollWidth).toBeLessThanOrEqual(link.clientWidth + 1);
    await expect(link.scrollHeight).toBeLessThanOrEqual(link.clientHeight + 1);
    await assertPeopleTarget(correction, frame, canvasElement);
    await expect(link.querySelector('a, button, input, details')).toBeNull();
    link.focus();
    await userEvent.tab();
    await expect(correction).toHaveFocus();
    await userEvent.tab();
    const summary = frame.querySelector('summary')!;
    await expect(summary).toHaveFocus();
    await assertPeopleTarget(summary, frame, canvasElement);
    await userEvent.keyboard('{Enter}');
    const code = frame.querySelector('code')!;
    await expect(code).toBeVisible();
    await expect(code.textContent).toBe(peopleWorkId);
    await expect(code.scrollWidth).toBeLessThanOrEqual(code.clientWidth + 1);
    await expect(canvas.getByRole('main').scrollWidth).toBeLessThanOrEqual(canvas.getByRole('main').clientWidth + 1);
  },
};
export const LongPersonReference: Story = { args: { mode: 'person', reference: 'long' } };
export const MissingWorkReference: Story = { args: { reference: 'missing' } };
export const WorkWithoutCreditField: Story = {
  args: { reference: 'no-credit' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText(m.people_profile_no_credit())).resolves.toBeVisible();
    await expect(canvas.queryByRole('link', { name: m.relation_title() })).toBeNull();
  },
};
export const CurrentSignedOut: Story = { args: { mode: 'person', session: 'signed-out' } };
export const CurrentSessionUnknown: Story = { args: { mode: 'person', session: 'unknown' } };
export const CurrentSessionUnavailable: Story = { args: { mode: 'person', session: 'unavailable' } };
export const WorkSessionUnknown: Story = { args: { session: 'unknown' } };
export const WorkSessionUnavailable: Story = { args: { session: 'unavailable' } };
export const ReferenceReloadFailure: Story = {
  args: { mode: 'person', reference: 'reload-failure' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('link', { name: 'Mira Sato' });
    await userEvent.click(canvas.getByRole('button', { name: m.correction_reload() }));
    await expect(canvas.findByText(m.correction_unavailable())).resolves.toBeVisible();
    await expect(canvas.queryByRole('link', { name: 'Mira Sato' })).toBeNull();
  },
};

function RetiringReference() {
  const [retired, setRetired] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setRetired(true)}>
        {m.account_sign_out()}
      </button>
      <CandidateReaderBoundary
        observed={
          retired
            ? { state: 'signed-out', csrfToken: null }
            : { state: 'signed-in', subject: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10', csrfToken: 'story-csrf-token' }
        }
        address="people-reference-story"
      >
        <ProfileStory
          mode="person"
          scenario={retired ? 'unavailable' : 'ready'}
          session={retired ? 'signed-out' : 'signed-in'}
        />
      </CandidateReaderBoundary>
    </>
  );
}
export const CurrentReadRetirement: Story = {
  render: () => <RetiringReference />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('link', { name: 'Mira Sato' });
    await userEvent.click(canvas.getByRole('button', { name: m.account_sign_out() }));
    await expect(canvas.findByText(m.correction_unavailable())).resolves.toBeVisible();
    await expect(canvasElement.textContent).not.toContain('Mira Sato');
  },
};
