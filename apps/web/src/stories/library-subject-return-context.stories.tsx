import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { SubjectLibrarySlot } from '../library/subject-slot-view';
import type { SubjectLibrarySlotData } from '../library/subject-slot';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { subjectHref } from '../subject/subject-href';
import subjectRecording from '../kernel/recorded/subject.json';
import realmRecording from '../kernel/recorded/realm.json';
import { PageStory, PatternStory, pageReady } from './page';

const meta = {
  title: 'Pages/Subjects/Library Sign-in Return Context',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The installed subject page reproduces the Library sign-in return link with a requested Realm. Recorded Global subject data does not prove Realm access or a native login. CurrentReaderView and CanonicalFallback mount the actual Library leaf in the existing shell; view pages do not currently mount this leaf themselves. Plays inspect the destination without starting authentication.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const realm = realmRecording.realm.realmId;
const signedOut: SubjectLibrarySlotData = {
  session: 'signed-out',
  csrfToken: null,
  entryAvailable: false,
  entry: null,
  publicCollections: null,
  publicCollectionsNext: null,
  collectionsLoaded: false,
  collections: null,
  labels: null,
};

function currentSubject() {
  const locale = getLocale();
  return {
    id: subjectRecording.subject.id,
    label: subjectRecording.subject.labels[locale],
    type: subjectRecording.subject.type,
  };
}

function LeafStory({ fallback = false }: { fallback?: boolean }) {
  const subject = currentSubject();
  const path = subjectHref(subject, getLocale()).href;
  return (
    <PatternStory path={fallback ? '/' : `${path}/editions?realm=${realm}&node=editions&cursor=opaque%2Bnext`}>
      <AppShell>
        <h1 className="font-sans text-3xl font-semibold">{subject.label}</h1>
        <SubjectLibrarySlot subject={subject} locale={getLocale()} data={signedOut} />
      </AppShell>
    </PatternStory>
  );
}

async function expectReturn(context: { canvasElement: HTMLElement }, query: string, view = '', fallback = false) {
  await pageReady(context);
  const link = context.canvasElement.querySelector('[data-library-sign-in]');
  const path = `${subjectHref(currentSubject(), getLocale()).href}${view}${query}`;
  const url = new URL(path, 'https://rezics.invalid');
  const target = fallback ? path : url.pathname + url.search;
  await expect(link).toHaveAttribute('href', `/auth/sign-in?return_to=${encodeURIComponent(target)}`);
  await expect(link).toHaveAccessibleName(m.account_sign_in());
  await expect(context.canvasElement.querySelector('[name="csrf_token"]')).toBeNull();
}

export const RealmReader: Story = {
  render: () => (
    <PageStory visitor="Signed Out" path={`${subjectHref(currentSubject(), getLocale()).href}?realm=${realm}`} />
  ),
  play: (context) => expectReturn(context, `?realm=${realm}`),
};

export const CurrentReaderView: Story = {
  render: () => <LeafStory />,
  play: (context) => expectReturn(context, `?realm=${realm}&node=editions&cursor=opaque%2Bnext`, '/editions'),
};

export const CanonicalFallback: Story = {
  render: () => <LeafStory fallback />,
  play: (context) => expectReturn(context, '', '', true),
};

export const PrivateParametersExcluded: Story = {
  render: () => (
    <PageStory
      visitor="Signed Out"
      path={`${subjectHref(currentSubject(), getLocale()).href}?realm=${realm}&code=private-code&csrf_token=private-csrf&return_to=https%3A%2F%2Fevil.test`}
    />
  ),
  play: async (context) => {
    await expectReturn(context, `?realm=${realm}`);
    const slot = within(context.canvasElement).getByRole('region', { name: m.library_subject_heading() });
    await expect(slot.querySelector('form')).toBeNull();
  },
};
