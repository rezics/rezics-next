import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import subjectRecording from '../kernel/recorded/subject.json';
import { qualifiedRealm, qualifiedSubject } from '../kernel/fake/qualified-relations';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { subjectHref } from '../subject/subject-href';
import { PageStory, pageReady } from './page';

const meta = {
  title: 'Subjects/Library Reader View',
  id: 'pages-subjects-library-reader-view',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Actual ordinary reader routes mount the compact SubjectFrame and the existing SubjectLibrarySlot. Global examples use recorded subject data; RealmCredits uses the existing constructed qualified-relations response and actual request context. These examples do not prove native Realm access, authentication, or visual composition without the supported preview sweep.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function currentSubject() {
  return { id: subjectRecording.subject.id, label: subjectRecording.subject.labels[getLocale()] };
}

function path(view: string) {
  return `${subjectHref(currentSubject(), getLocale()).href}/${view}`;
}

async function signedOutReader(context: { canvasElement: HTMLElement }, current: string, heading: string) {
  await pageReady(context);
  const canvas = within(context.canvasElement);
  await canvas.findByRole('heading', { level: 1, name: heading });
  const frame = context.canvasElement.querySelector('[data-slot="subject-frame"]');
  if (!frame) throw new Error('The ordinary reader did not render its compact frame');
  const slots = frame.querySelectorAll('[data-slot="subject-library"]');
  await expect(slots).toHaveLength(1);
  const slot = slots[0]!;
  const signIn = await within(slot as HTMLElement).findByRole('link', { name: m.account_sign_in() });
  const url = new URL(current, 'https://rezics.invalid');
  await expect(signIn).toHaveAttribute(
    'href',
    `/auth/sign-in?return_to=${encodeURIComponent(url.pathname + url.search)}`,
  );
  await expect(slot.querySelector('form')).toBeNull();
  await expect(frame.querySelector('[data-slot="view-tabs"]')).not.toBeNull();
}

export const DetailsSignedOut: Story = {
  render: () => <PageStory visitor="Signed Out" path={path('details')} />,
  play: (context) => signedOutReader(context, path('details'), m.subject_details()),
};

export const DetailsSignedIn: Story = {
  render: () => <PageStory visitor="Signed In" path={path('details')} />,
  play: async (context) => {
    await pageReady(context);
    await within(context.canvasElement).findByRole('heading', { level: 1, name: m.subject_details() });
    const slot = context.canvasElement.querySelector('[data-slot="subject-library"]');
    if (!slot) throw new Error('The ordinary reader did not render its Library slot');
    await within(slot as HTMLElement).findByRole('navigation', { name: m.library_subject_more_options() });
    await expect(slot.querySelector('[data-library-sign-in]')).toBeNull();
  },
};

function realmCreditsPath() {
  return `${subjectHref(qualifiedSubject, getLocale()).href}/credits?realm=${qualifiedRealm}`;
}

export const RealmCredits: Story = {
  render: () => <PageStory visitor="Signed Out" path={realmCreditsPath()} />,
  play: (context) => signedOutReader(context, realmCreditsPath(), m.subject_credits()),
};

export const RelationsSignedOut: Story = {
  render: () => <PageStory visitor="Signed Out" path={path('relations')} />,
  play: (context) => signedOutReader(context, path('relations'), m.subject_relations()),
};
