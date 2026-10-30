import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { setCopiesStoryMode, type CopiesStoryMode } from '../kernel/fake/copies-page-stories';
import { useState } from 'react';
import { CopyForm } from '../library/copies-page';
import type { CopyItem } from '../library/copies-read';
import { setCopyKindsStory } from '../kernel/fake/copies-kinds';
import recording from '../kernel/recorded/library-copies.json';
import { unprofiledSubjectId } from '../kernel/fake/library-unprofiled-subject';
import { m } from '../paraglide/messages.js';
import { PageStory, PatternStory, pagePaths, pageReady } from './page';

const meta = { title: 'Pages/Library/Copies', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function CopiesStory({ mode }: { mode: CopiesStoryMode }) {
  setCopiesStoryMode(mode);
  return <PageStory visitor="Signed In" path={pagePaths['library-copies']} />;
}

const ready = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  await within(canvasElement).findByRole('heading', { level: 1, name: m.library_copy_heading() });
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
    // No historical profile labels accompany this recording; preserve the raw kind and status.
    expect(kokoro.textContent).toContain('digital');
    expect(kokoro.textContent).not.toContain('physical');
    expect(kokoro.textContent).toContain(recordedCopy.status);
    expect(within(kokoro).getByText(m.library_history_unavailable(), { exact: true })).toBeVisible();
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

// Bounded view inputs for the adopted presentation. These do not supply a native presentation adapter:
// this base's generated point DTO still lacks that body and its presentation query.
type HistoricMode = 'known' | 'retired' | 'unknown' | 'unavailable';
function HistoricView({ mode }: { mode: HistoricMode }) {
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
    await view.findByText('On shelf at acceptance');
    expect(view.queryByText('Renamed at current head')).not.toBeInTheDocument();
    await view.findByRole('combobox', { name: m.library_copy_new_status() });
  },
};
export const UnknownLegacy: Story = {
  name: 'Unknown legacy meaning (bounded view)',
  render: () => <HistoricView mode="unknown" />,
  async play() {
    const view = within(document.body);
    await view.findByText('legacy-unspecified');
    await view.findByText(m.library_copy_meaning_unknown());
    expect(view.queryByRole('combobox')).not.toBeInTheDocument();
  },
};
export const RequiredReleaseUnavailable: Story = {
  name: 'Accepted release unavailable (bounded view)',
  render: () => <HistoricView mode="unavailable" />,
  async play() {
    const view = within(document.body);
    await view.findByText(m.library_history_unavailable());
    await view.findByText(m.library_copy_status_unavailable());
    await view.findByRole('button', { name: m.library_copy_delete() });
  },
};
export const DeniedDetail: Story = {
  name: 'Owner list readable, point detail denied',
  render: () => <CopiesStory mode="denied-detail" />,
  async play(args) {
    await ready(args);
    const canvas = within(args.canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.library_copy_more_actions() }));
    const view = within(document.body);
    await userEvent.click(view.getByRole('menuitem', { name: m.library_copy_edit() }));
    await view.findByText(m.library_copy_detail_forbidden());
    const dialog = within(view.getByRole('dialog'));
    expect(dialog.queryByText(recording.copies[0]!.note!)).not.toBeInTheDocument();
    expect(dialog.queryByRole('button', { name: m.library_copy_save() })).not.toBeInTheDocument();
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
