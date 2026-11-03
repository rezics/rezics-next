import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useEffect, useState } from 'react';
import { documentText, fromPlainText } from '@rezics/document';
import { Button } from '@rezics/ui/shadcn/button';
import { LocalWritingDraftControls } from '../threads/local-writing-draft-controls';
import {
  BrowserWritingStore,
  LocalWritingDraft,
  prepareWriting,
  writingIndexKey,
  writingScope,
  type WritingStorage,
} from '../threads/local-writing-draft';
import { m } from '../paraglide/messages.js';

type Scenario = 'writing' | 'preview' | 'unknown' | 'storage' | 'corrupt' | 'attachments';
class PreparedStorage implements WritingStorage {
  values = new Map<string, string>();
  denied = false;
  getItem(key: string) {
    if (this.denied) throw new Error('Prepared storage denial');
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.denied) throw new Error('Prepared storage denial');
    this.values.set(key, value);
  }
  removeItem(key: string) {
    if (this.denied) throw new Error('Prepared storage denial');
    this.values.delete(key);
  }
}
const actor = 'prepared-writer';
const scope = writingScope({ containerId: 'prepared-thread' })!;
const initialText = 'A private unsent thought. 私の下書き。\n\nA second paragraph to keep after reloading.';

function Example({ scenario, width, dark, long }: { scenario: Scenario; width: number; dark: boolean; long: boolean }) {
  const [storage] = useState(() => {
    const value = new PreparedStorage();
    if (['preview', 'unknown', 'attachments'].includes(scenario)) {
      const store = new BrowserWritingStore(value, () => Date.UTC(2026, 10, 1, 10));
      const payload = prepareWriting(
        long ? 'A very long title with multilingual writing and room for wrapping. '.repeat(8) : '',
        fromPlainText(initialText, 'blocks'),
      );
      payload.attachmentRepair = scenario === 'attachments';
      const result = store.save(actor, scope, payload, null);
      if ('saved' in result && scenario === 'unknown') store.mark(result.saved, 'unknown');
    }
    if (scenario === 'corrupt') value.values.set(writingIndexKey, '{broken');
    value.denied = scenario === 'storage';
    return value;
  });
  const [epoch, setEpoch] = useState(0);
  const [retired, setRetired] = useState(false);
  const [body, setBody] = useState(() =>
    fromPlainText(
      scenario === 'writing' || scenario === 'storage' || scenario === 'corrupt' ? initialText : '',
      'blocks',
    ),
  );
  const [title, setTitle] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [notice, setNotice] = useState(false);
  const [owner, setOwner] = useState(() => new AbortController());
  const [draft, setDraft] = useState<LocalWritingDraft | null>(null);
  useEffect(() => {
    const next = new LocalWritingDraft(
      () => new BrowserWritingStore(storage),
      actor,
      scope,
      () => !owner.signal.aborted,
      owner.signal,
    );
    setDraft(next);
    next.load();
    return () => next.retire();
  }, [epoch, owner, storage]);
  const read = () => prepareWriting(title, body);
  useEffect(() => {
    if (!unknown) draft?.schedule(read);
  }, [draft, title, body, unknown]);
  const reload = () => {
    owner.abort();
    setOwner(new AbortController());
    setBody(fromPlainText('', 'blocks'));
    setTitle('');
    setUnknown(false);
    setConfirmed(false);
    setNotice(false);
    setEpoch((value) => value + 1);
  };
  return (
    <div className={dark ? 'dark' : ''} style={{ width, maxWidth: '100%' }}>
      <main className="min-h-screen min-w-0 space-y-4 bg-background p-4 text-foreground">
        <p className="rounded border border-border p-3 text-sm">
          Prepared fixture: isolated browser storage and admitted account. Reload, account changes and submission
          outcomes below are supplied controls; no native request is sent.
        </p>
        {retired ? (
          <p role="alert">{m.thread_authoring_session_changed()}</p>
        ) : (
          <>
            <label className="block">
              {m.thread_title_label()}
              <input
                className="h-11 w-full rounded border border-border bg-background p-2"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label className="block">
              {m.thread_new_body_label()}
              <textarea
                className="min-h-40 w-full rounded border border-border bg-background p-3"
                value={documentText(body)}
                onChange={(event) => setBody(fromPlainText(event.target.value, 'blocks'))}
              />
            </label>
            {draft ? (
              <LocalWritingDraftControls
                key={epoch}
                draft={draft}
                read={read}
                live={() => ({ title, body })}
                suspended={unknown}
                restoreDisabled={false}
                hasLiveWriting={Boolean(title || documentText(body))}
                onRestore={(payload) => {
                  setTitle(payload.title);
                  setBody(payload.body);
                  setNotice(payload.attachmentRepair);
                }}
              />
            ) : null}
            {notice ? <p role="status">{m.thread_draft_attachments()}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button className="min-h-11" onClick={reload}>
                Prepared reload
              </Button>
              <Button
                className="min-h-11"
                onClick={() => {
                  if (draft?.beginSubmission()) {
                    draft.settle('success');
                    setBody(fromPlainText('', 'blocks'));
                    setTitle('');
                    setConfirmed(true);
                  }
                }}
              >
                Prepared confirmed submit
              </Button>
              <Button
                className="min-h-11"
                onClick={() => {
                  if (draft?.beginSubmission()) {
                    draft.settle('unknown');
                    setUnknown(true);
                  }
                }}
              >
                Prepared lost response
              </Button>
              <Button
                className="min-h-11"
                onClick={() => {
                  if (draft?.beginSubmission()) draft.settle('refused');
                }}
              >
                Prepared refusal
              </Button>
              <Button
                className="min-h-11"
                onClick={() => {
                  owner.abort();
                  setRetired(true);
                }}
              >
                Prepared account away/back
              </Button>
            </div>
            {confirmed ? <p role="status">Prepared confirmed submission; exact browser copy removed.</p> : null}
          </>
        )}
      </main>
    </div>
  );
}

const meta = {
  title: 'Authoring/Browser writing recovery',
  component: Example,
  parameters: { layout: 'fullscreen' },
  args: { scenario: 'writing', width: 390, dark: false, long: false },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
const journey: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const view = within(canvasElement);
  await userEvent.click(await view.findByRole('button', { name: m.thread_draft_save() }));
  await waitFor(() => expect(view.queryByRole('button', { name: m.thread_draft_discard() })).toBeInTheDocument(), {
    timeout: 3000,
  });
  await userEvent.click(view.getByRole('button', { name: 'Prepared reload' }));
  await userEvent.click(await view.findByRole('button', { name: m.thread_draft_restore() }));
  await expect(view.getByRole('textbox', { name: m.thread_new_body_label() })).toHaveValue(initialText);
  await userEvent.click(view.getByRole('button', { name: m.thread_draft_export() }));
  const exported = view.getByRole('textbox', { name: m.thread_draft_export_hint() });
  await expect(exported).toHaveFocus();
  await userEvent.tab();
  await expect(view.getByRole('button', { name: m.thread_draft_copy() })).toHaveFocus();
  await userEvent.click(view.getByRole('button', { name: 'Prepared confirmed submit' }));
  await userEvent.click(view.getByRole('button', { name: 'Prepared reload' }));
  await expect(view.queryByRole('button', { name: m.thread_draft_restore() })).not.toBeInTheDocument();
};
export const PhoneLightJourney: Story = { play: journey };
export const PhoneDarkJourney: Story = { args: { dark: true }, play: journey };
export const DesktopLightJourney: Story = { args: { width: 1280 }, play: journey };
export const DesktopDarkJourney: Story = { args: { width: 1280, dark: true }, play: journey };
export const LongPreviewKeyboardDiscard: Story = {
  args: { scenario: 'preview', long: true, dark: true },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const discard = await view.findByRole('button', { name: m.thread_draft_discard() });
    discard.focus();
    await userEvent.keyboard('{Enter}');
    await expect(view.queryByRole('button', { name: m.thread_draft_restore() })).not.toBeInTheDocument();
  },
};
export const UnknownNeverReplays: Story = {
  args: { scenario: 'unknown' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByRole('button', { name: m.thread_draft_restore() })).toBeDisabled();
    await userEvent.click(view.getByRole('button', { name: 'Prepared refusal' }));
    await expect(view.getByRole('button', { name: m.thread_draft_restore() })).toBeDisabled();
  },
};
export const StorageDeniedExport: Story = {
  args: { scenario: 'storage' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText(m.thread_draft_storage_error());
    await userEvent.click(view.getByRole('button', { name: m.thread_draft_export() }));
    await expect(view.getByRole('textbox', { name: m.thread_draft_export_hint() })).toHaveValue(initialText);
  },
};
export const CorruptStorage: Story = { args: { scenario: 'corrupt', width: 1280, dark: true } };
export const AttachmentRepair: Story = {
  args: { scenario: 'attachments' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText(m.thread_draft_attachments());
    await userEvent.click(view.getByRole('button', { name: m.thread_draft_restore() }));
    await view.findByText(m.thread_draft_attachments());
  },
};
export const AwayBackRedactsPreview: Story = {
  args: { scenario: 'preview' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByRole('button', { name: m.thread_draft_restore() });
    await userEvent.click(view.getByRole('button', { name: 'Prepared account away/back' }));
    await expect(view.queryByText(initialText)).not.toBeInTheDocument();
    await view.findByText(m.thread_authoring_session_changed());
  },
};
