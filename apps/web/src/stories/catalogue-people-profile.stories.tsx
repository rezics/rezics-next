import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useMemo } from 'react';
import { pickText } from '@rezics/composition';
import { PeopleProfileEditor } from '../features/catalogue/people-profile-view';
import { RelationEditor } from '../features/catalogue/relation-editor';
import { relationFields } from '../subject/relation-candidates';
import {
  peopleProfileFixture,
  peopleCreatedId,
  peoplePersonId,
  peopleOrganizationId,
  selectPeopleProfileStory,
  type PeopleScenario,
  type PeopleMode,
} from '../kernel/fake/catalogue-people-profile';
import definitions from '../kernel/recorded/definitions-release.json';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { PageStory, PatternStory } from './page';

function ProfileStory({
  scenario = 'ready',
  mode = 'create',
  signedOut = false,
}: {
  scenario?: PeopleScenario;
  mode?: PeopleMode;
  signedOut?: boolean;
}) {
  const locale = getLocale();
  const fixture = useMemo(() => peopleProfileFixture(scenario, locale, mode), [scenario, locale, mode]);
  return (
    <PatternStory visitor={signedOut ? 'Signed Out' : 'Signed In'} path="/catalogue/people">
      <AppShell>
        <PeopleProfileEditor
          locale={locale}
          {...(mode !== 'create' ? { id: fixture.id } : {})}
          session={signedOut ? 'signed-out' : 'signed-in'}
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
async function submit(canvasElement: HTMLElement) {
  const canvas = await fill(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
  return canvas;
}
export const Create: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
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
