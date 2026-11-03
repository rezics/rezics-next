import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { setCopiesStoryMode, type CopiesStoryMode } from '../kernel/fake/copies-page-stories';
import { useState } from 'react';
import { CopyForm, CopiesPage } from '../library/copies-page';
import type { CopyItem } from '../library/copies-read';
import { setCopyKindsStory } from '../kernel/fake/copies-kinds';
import recording from '../kernel/recorded/library-copies.json';
import { unprofiledSubjectId } from '../kernel/fake/library-unprofiled-subject';
import { subjectOf } from '../library/reads';
import { displayLibraryTitle } from '../library/title';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { PageStory, PatternStory, pagePaths, pageReady } from './page';

const meta = {
  title: 'Pages/Library/Copies',
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' }, type: 'desktop' },
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function CopiesStory({ mode }: { mode: CopiesStoryMode }) {
  setCopiesStoryMode(mode);
  return <PageStory visitor="Signed In" path={pagePaths['library-copies']} />;
}

const ready = async (context: { canvasElement: HTMLElement }) => {
  await pageReady(context);
  await within(context.canvasElement).findByRole('heading', { level: 1, name: m.library_copy_heading() });
};

export const ManyCopies: Story = {
  name: 'Owner',
  render: () => <CopiesStory mode="many" />,
  async play(args) {
    await ready(args);
    const canvas = within(args.canvasElement);
    const recordedCopy = recording.copies[1];
    const coverMedia = recordedCopy?.subject.cover?.media;
    if (!recordedCopy || typeof coverMedia !== 'string' || !recordedCopy.note) {
      throw new globalThis.Error('The recorded Kokoro copy has no cover media or identifying note.');
    }
    const kokoro = (await canvas.findByText(recordedCopy.note, { exact: true })).closest('li');
    if (!kokoro) throw new globalThis.Error('The recorded Kokoro copy did not render in the list.');
    expect(kokoro.textContent).toContain('Kokoro');
    expect(canvas.getAllByText(m.library_copy_history_notice(), { exact: true })).toHaveLength(1);
    // The ordinary row stays readable; the closed disclosure retains this copy's exact evidence.
    expect(kokoro.textContent).toContain('digital');
    expect(kokoro.textContent).not.toContain('physical');
    expect(kokoro.textContent).toContain(recordedCopy.status);
    const disclosure = within(kokoro).getByText(m.library_copy_history_details(), { exact: true });
    expect(disclosure.closest('details')).not.toHaveAttribute('open');
    expect(within(kokoro).getByText('digital', { exact: true })).not.toBeVisible();
    expect(within(kokoro).getByText(m.library_history_unavailable(), { exact: true })).not.toBeVisible();
    await userEvent.click(disclosure);
    expect(within(kokoro).getByText('digital', { exact: true })).toBeVisible();
    expect(within(kokoro).getByText(m.library_history_unavailable(), { exact: true })).toBeVisible();
    await userEvent.click(disclosure);
    const image = kokoro.querySelector('[data-slot="cover"] img');
    if (!image?.getAttribute('src')?.includes(`/media/${coverMedia}/`)) {
      throw new globalThis.Error('The recorded Kokoro copy cover did not render from its /media/ fixture.');
    }
    await userEvent.hover(kokoro);
  },
};
export const None: Story = {
  name: 'Owner, empty',
  render: () => <CopiesStory mode="none" />,
  play: ready,
};
export const OneCopy: Story = {
  name: 'Owner, one copy',
  render: () => <CopiesStory mode="one" />,
  play: ready,
};

export const LongContent: Story = {
  name: 'Long content',
  render: () => <CopiesStory mode="long" />,
  async play({ canvasElement }) {
    await ready({ canvasElement });
    await within(canvasElement).findByText('Library copy story 12');
  },
};

export const Unavailable: Story = {
  name: 'Unavailable',
  render: () => <CopiesStory mode="unavailable" />,
  async play(context) {
    await pageReady(context);
    await within(context.canvasElement).findByRole('heading', { level: 1, name: m.error_heading() });
  },
};

export const Error: Story = {
  name: 'Error',
  render: () => <CopiesStory mode="error" />,
  async play(context) {
    await pageReady(context);
    await within(context.canvasElement).findByRole('heading', { level: 1, name: m.error_heading() });
  },
};

function ProfileStory({ retired = false }: { retired?: boolean }) {
  setCopiesStoryMode('one');
  setCopyKindsStory(retired);
  return <PageStory visitor="Signed In" path="/library/copies?subjectId=01a17a3b-0884-721b-91ef-d7ffd7bb58e4" />;
}
export const NoLongerOffered: Story = {
  name: 'Owner, copy type unavailable',
  render: () => <ProfileStory retired />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 1, name: m.library_copy_heading() });
    await userEvent.click(canvas.getByRole('button', { name: m.library_copy_delete() }));
    await within(document.body).findByText(m.library_copy_no_longer_offered());
  },
};

export const UnsupportedProfile: Story = {
  name: 'No add option for an unprofiled subject',
  render: () => (
    <PageStory visitor="Signed In" path={`/library/copies?subjectId=${encodeURIComponent(unprofiledSubjectId)}`} />
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 1, name: m.library_copy_heading() });
    await canvas.findByRole('status', { name: m.library_copy_unsupported() });
    expect(canvas.queryByRole('button', { name: m.library_copy_add() })).not.toBeInTheDocument();
  },
};

// Bounded inputs illustrate historical presentation; these fixtures do not establish native acceptance.
type HistoricMode = 'known' | 'retired' | 'unknown' | 'unavailable';
function HistoricView({ mode, list = false }: { mode: HistoricMode; list?: boolean }) {
  const [copy, setCopy] = useState<CopyItem>(() => {
    setCopiesStoryMode('one');
    setCopyKindsStory();
    const original = recording.copies[0]!;
    return {
      ...original,
      subject: null,
      kind: mode === 'unknown' ? 'legacy-unspecified' : 'print',
      status: 'shelf',
      idempotencyKey: '10203040-5060-4070-8090-102030405060',
      meaning: mode === 'unknown' ? 'unknown' : mode === 'unavailable' ? 'unavailable' : 'known',
      ...(mode === 'known' || mode === 'retired'
        ? {
            kindLabel: 'Print at acceptance',
            kindLabelLanguage: 'en',
            statusLabel: 'On shelf at acceptance',
            statusLabelLanguage: 'en',
          }
        : {}),
      statusEditing:
        mode === 'known'
          ? { state: 'supported', statuses: [{ id: 'loan', label: 'On loan now', labelLanguage: 'en' }] }
          : { state: mode === 'retired' ? 'unsupported' : 'unavailable' },
    };
  });
  return (
    <PatternStory visitor="Signed In" path={pagePaths['library-copies']}>
      <div className="w-full max-w-4xl p-4">
        {list ? (
          <CopiesPage
            page={{
              signedIn: true,
              copies: [copy],
              subjectId: null,
              next: null,
              addKey: copy.idempotencyKey,
            }}
          />
        ) : (
          <CopyForm
            key={`${copy.id}:${copy.revision}`}
            copy={copy}
            inline
            subjectId={null}
            // Today's renamed labels are deliberately irrelevant to accepted holding meaning.
            profile={{ kinds: [{ id: 'print', label: 'Renamed at current head', statuses: [] }] }}
            addKey={copy.idempotencyKey}
            onClose={() => {}}
            onCreated={() => {}}
            onSaved={setCopy}
            onRemoved={() => {}}
            onKey={() => {}}
          />
        )}
      </div>
    </PatternStory>
  );
}

export const KnownHistoricalLabels: Story = {
  name: 'Accepted labels and separate current choices (bounded view)',
  render: () => <HistoricView mode="known" />,
  async play() {
    const view = within(document.body);
    await view.findByText('Print at acceptance');
    expect(view.getAllByText('On shelf at acceptance').length).toBeGreaterThan(0);
    expect(view.queryByText('Renamed at current head')).not.toBeInTheDocument();
    await view.findByRole('combobox', { name: m.library_copy_new_status() });
  },
};
export const UnknownLegacy: Story = {
  name: 'Unknown legacy meaning (bounded view)',
  render: () => <HistoricView mode="unknown" list />,
  async play({ canvasElement }) {
    await ready({ canvasElement });
    const canvas = within(canvasElement);
    expect(canvas.getByText(m.library_copy_history_notice())).toBeVisible();
    const disclosure = canvas.getByText(m.library_copy_history_details());
    expect(disclosure.closest('details')).not.toHaveAttribute('open');
    expect(canvas.getByText('legacy-unspecified')).not.toBeVisible();
    await userEvent.click(disclosure);
    expect(canvas.getByText('legacy-unspecified')).toBeVisible();
    expect(canvas.getByText(m.library_copy_meaning_unknown())).toBeVisible();
    expect(canvas.queryByText('Renamed at current head')).not.toBeInTheDocument();
    expect(canvas.queryByRole('combobox')).not.toBeInTheDocument();
  },
};
export const RequiredReleaseUnavailable: Story = {
  name: 'Accepted release unavailable (bounded view)',
  render: () => <HistoricView mode="unavailable" list />,
  async play({ canvasElement }) {
    await ready({ canvasElement });
    const canvas = within(canvasElement);
    expect(canvas.getByText(m.library_copy_history_notice())).toBeVisible();
    const disclosure = canvas.getByText(m.library_copy_history_details());
    expect(disclosure.closest('details')).not.toHaveAttribute('open');
    await userEvent.click(disclosure);
    expect(canvas.getByText(m.library_history_unavailable())).toBeVisible();
    expect(canvas.queryByText('Renamed at current head')).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: m.library_copy_more_actions() }));
    const view = within(document.body);
    const sheet = window.matchMedia('(max-width: 767px)').matches || window.matchMedia('(pointer: coarse)').matches;
    const actions = await view.findByRole(sheet ? 'dialog' : 'menu', { name: m.library_copy_more_actions() });
    await userEvent.click(within(actions).getByRole(sheet ? 'button' : 'menuitem', { name: m.library_copy_edit() }));
    await view.findByRole('dialog', { name: m.library_copy_edit() });
    await view.findByText(m.library_copy_status_unavailable());
    await view.findByRole('button', { name: m.library_copy_delete() });
    await userEvent.click(view.getByRole('button', { name: m.library_copy_cancel() }));
    expect(canvas.getByText(m.library_history_unavailable())).toBeVisible();
  },
};
export const DeniedDetail: Story = {
  name: 'Owner list readable, point detail denied',
  render: () => <CopiesStory mode="denied-detail" />,
  async play(args) {
    await ready(args);
    const canvas = within(args.canvasElement);
    const recordedCopy = recording.copies[0]!;
    const row = (await canvas.findByText(recordedCopy.note!, { exact: true })).closest('li');
    if (!row) throw new globalThis.Error('The recorded owner copy did not render in the list.');
    const rawRow = row.textContent;
    const trigger = within(row).getByRole('button', { name: m.library_copy_more_actions() });
    await userEvent.click(trigger);
    const view = within(document.body);
    // Menu uses a titled sheet with buttons on phones and coarse pointers, and a portalled menu on desktop.
    const sheet = window.matchMedia('(max-width: 767px)').matches || window.matchMedia('(pointer: coarse)').matches;
    const actions = await view.findByRole(sheet ? 'dialog' : 'menu', {
      name: m.library_copy_more_actions(),
    });
    if (!sheet) expect(actions.id).toBe(trigger.getAttribute('aria-controls'));
    const edit = await within(actions).findByRole(sheet ? 'button' : 'menuitem', {
      name: m.library_copy_edit(),
    });
    expect(edit).toBeVisible();
    await userEvent.click(edit);
    // Wait for the current inspection before binding to an editor that remounts when its detail state changes.
    await view.findByText(m.library_copy_detail_forbidden());
    const dialog = within(view.getByRole('dialog', { name: m.library_copy_edit() }));
    expect(dialog.queryByText(recording.copies[0]!.note!)).not.toBeInTheDocument();
    expect(dialog.queryByRole('button', { name: m.library_copy_save() })).not.toBeInTheDocument();
    expect(dialog.queryByRole('button', { name: m.library_copy_delete() })).not.toBeInTheDocument();
    expect(dialog.queryByRole('combobox')).not.toBeInTheDocument();
    expect(row).toBeInTheDocument();
    expect(row.textContent).toBe(rawRow);
  },
};
export const ExactCapturedStatusEdit: Story = {
  name: 'Captured status choice, native revisioned write (bounded view)',
  render: () => <HistoricView mode="known" />,
  async play() {
    const view = within(document.body);
    const status = await view.findByRole('combobox', { name: m.library_copy_new_status() });
    await userEvent.selectOptions(status, 'loan');
    await userEvent.click(view.getByRole('button', { name: m.library_copy_save() }));
    await view.findByText('loan', { exact: true });
    // The write response has no accepted presentation: retain raw status until another explicit inspect.
    await view.findByText(m.library_history_unavailable());
  },
};

export const HeadRenamedPairRetired: Story = {
  name: 'Owner, historical pair retired',
  render: () => <HistoricView mode="retired" />,
  async play() {
    const view = within(document.body);
    await view.findByText(m.library_copy_status_unsupported());
    expect(await view.findByText('Print at acceptance')).toBeVisible();
    expect(await view.findByRole('button', { name: m.library_copy_delete() })).toBeVisible();
  },
};

// UNRUN bounded presentation cases; these add no native or screenshot acceptance claim.
function RecoveryView({
  filtered = false,
  long = false,
  unavailable = false,
}: {
  filtered?: boolean;
  long?: boolean;
  unavailable?: boolean;
}) {
  const original = recording.copies[0]!;
  const subject = subjectOf(original.subject);
  const title = subject ? displayLibraryTitle(subject.label, getLocale()) : null;
  const copy: CopyItem = {
    ...original,
    kind: null,
    subject: unavailable ? null : subject,
    idempotencyKey: '10203040-5060-4070-8090-102030405060',
    meaning: unavailable ? 'unavailable' : 'unknown',
    statusEditing: { state: 'unavailable' },
    ...(long && subject && title
      ? {
          subject: {
            ...subject,
            label: { value: `${title.text} — ${title.text} — ${title.text}`, language: title.lang ?? getLocale() },
          },
          note: `${original.note ?? ''} ${original.note ?? ''} ${original.note ?? ''}`,
        }
      : {}),
  };
  return (
    <PatternStory visitor="Signed In" path={pagePaths['library-copies']}>
      <div className="w-full max-w-4xl p-4">
        <CopiesPage
          page={{
            signedIn: true,
            subjectId: filtered ? original.subjectId : null,
            requestedCursor: 'later/keyset+page',
            copies: long || unavailable ? [copy] : [],
            next: long ? 'next/keyset+page' : null,
            addKey: copy.idempotencyKey,
          }}
        />
      </div>
    </PatternStory>
  );
}

export const EmptyLaterPage: Story = {
  name: 'Empty later page, explicit first-page recovery',
  render: () => <RecoveryView />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    expect(await canvas.findByRole('status')).toHaveTextContent(m.library_copy_page_empty());
    expect(canvas.queryByText(m.library_copy_empty())).not.toBeInTheDocument();
    const first = await canvas.findByRole('link', { name: m.library_collections_first_page() });
    expect(new URL(first.getAttribute('href')!, window.location.href).searchParams.has('cursor')).toBe(false);
    expect(canvas.queryByRole('link', { name: m.library_copy_more() })).not.toBeInTheDocument();
    expect(canvas.getByRole('button', { name: m.library_copy_add() })).toBeVisible();
  },
};

export const FilteredEmptyLaterPage: Story = {
  name: 'Empty later edition page retains its filter',
  render: () => <RecoveryView filtered />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await canvas.findByText(m.library_copy_page_empty());
    expect(canvas.queryByText(m.library_copy_filtered_empty())).not.toBeInTheDocument();
    const first = await canvas.findByRole('link', { name: m.library_collections_first_page() });
    const target = new URL(first.getAttribute('href')!, window.location.href);
    expect(target.searchParams.get('subjectId')).toBe(recording.copies[0]!.subjectId);
    expect(target.searchParams.has('cursor')).toBe(false);
    expect(canvas.getByRole('link', { name: m.library_copy_all() })).toBeVisible();
  },
};

export const LongLaterPage: Story = {
  name: 'Later page, long text and independent recovery controls',
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <RecoveryView filtered long />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 2 });
    await expect(await canvas.findByRole('link', { name: m.library_collections_first_page() })).toBeVisible();
    await expect(await canvas.findByRole('link', { name: m.library_copy_more() })).toBeVisible();
    expect(canvas.getByText(m.library_copy_history_notice())).toBeVisible();
    expect(canvas.queryByText(m.library_copy_page_empty())).not.toBeInTheDocument();
  },
};

export const UnavailableLaterPage: Story = {
  name: 'Later page with unavailable subject and meaning',
  render: () => <RecoveryView unavailable />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 2, name: m.library_subject_unavailable() });
    await expect(await canvas.findByRole('link', { name: m.library_collections_first_page() })).toBeVisible();
    await userEvent.click(canvas.getByText(m.library_copy_history_details()));
    expect(canvas.getByText(m.library_history_unavailable())).toBeVisible();
  },
};
