import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { commandLane } from '../api/command.ts';
import { commitCommand, type WriteResult } from './api.ts';
import { ZoneEditorDraftProvider, useUnsavedZoneEditorSections, useZoneEditorDraft, useZoneEditorExit, useZoneEditorExitActions, useZoneEditorRef } from './draft-provider.tsx';
import type { DraftStorage, ZoneEditorSection } from './draft-state.ts';

interface TextDraft {
  value: string;
  savedValue: string;
}

const title = { value: 'Saved title', savedValue: 'Saved title' };
const body = { value: 'Saved home page', savedValue: 'Saved home page' };
const fieldClass = 'rounded-md border border-input bg-background p-3 text-foreground';
const buttonClass = 'rounded-md border border-input px-3 py-2';

function accepts(value: unknown): value is TextDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<TextDraft>;
  return typeof draft.value === 'string' && typeof draft.savedValue === 'string';
}

const isDirty = (draft: TextDraft) => draft.value !== draft.savedValue;

function DraftFields() {
  const [heading, setHeading, headingReady] = useZoneEditorDraft('navigation', title, isDirty, accepts);
  const [page, setPage, pageReady] = useZoneEditorDraft('home', body, isDirty, accepts);
  return <div className="grid gap-4">
    <label className="grid gap-2">Site title
      <input className={fieldClass} value={heading.value} disabled={!headingReady}
        onChange={event => setHeading(current => ({ ...current, value: event.target.value }))} />
    </label>
    <label className="grid gap-2">Home page
      <textarea className={`${fieldClass} min-h-32`} value={page.value} disabled={!pageReady}
        onChange={event => setPage(current => ({ ...current, value: event.target.value }))} />
    </label>
  </div>;
}

function Sections({ switchAuthor }: { switchAuthor(): void }) {
  const [section, setSection] = useState<'home' | 'theme'>('home');
  const unsaved = useUnsavedZoneEditorSections();
  return <>
    <nav aria-label="Editor sections" className="flex flex-wrap gap-2">
      <button className={buttonClass} aria-pressed={section === 'home'} onClick={() => setSection('home')}>Home</button>
      <button className={buttonClass} aria-pressed={section === 'theme'} onClick={() => setSection('theme')}>Theme</button>
      <button className={buttonClass} onClick={switchAuthor}>Switch author</button>
    </nav>
    <p role="status">{unsaved.length ? `Unsaved sections: ${unsaved.join(', ')}` : 'All changes saved'}</p>
    {section === 'home' ? <DraftFields /> : <p>Theme section</p>}
  </>;
}

function Page({ storageFailure }: { storageFailure: 'unavailable' | 'quota' }) {
  const [actingSubject, setActingSubject] = useState('author');
  return <main className="mx-auto grid max-w-2xl gap-4 p-6">
    <h1 className="text-xl font-semibold">Zone draft continuity</h1>
    <p>{storageFailure === 'unavailable' ? 'Session storage is unavailable' : 'Session storage is full'}</p>
    <p>Editing as {actingSubject}</p>
    <ZoneEditorDraftProvider zoneId="harbor" actingSubject={actingSubject}>
      <Sections switchAuthor={() => setActingSubject(current => current === 'author' ? 'another-author' : 'author')} />
    </ZoneEditorDraftProvider>
  </main>;
}

let storageFailures = 0;
const meta = {
  title: 'Zone editor/Draft continuity',
  component: Page,
  args: { storageFailure: 'unavailable' as const },
  beforeEach({ args }) {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    const values = new Map<string, string>();
    storageFailures = 0;
    const storage: DraftStorage = {
      getItem: key => values.get(key) ?? null,
      setItem() { storageFailures += 1; throw new DOMException('Storage is full', 'QuotaExceededError'); },
      removeItem: key => { values.delete(key); },
    };
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        if (args.storageFailure === 'unavailable') {
          storageFailures += 1;
          throw new DOMException('Storage is unavailable', 'SecurityError');
        }
        return storage;
      },
    });
    return () => {
      if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
      else Reflect.deleteProperty(globalThis, 'sessionStorage');
    };
  },
} satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

const verifiesDraftContinuity: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const heading = await canvas.findByRole('textbox', { name: 'Site title' });
  const page = await canvas.findByRole('textbox', { name: 'Home page' });
  await expect(heading).toBeEnabled();
  await expect(page).toBeEnabled();
  await userEvent.clear(heading);
  await userEvent.type(heading, 'Unsaved harbor title');
  await userEvent.clear(page);
  await userEvent.type(page, 'An unsaved home page body');
  await expect(canvas.getByRole('status')).toHaveTextContent('Unsaved sections: home, navigation');
  await userEvent.click(canvas.getByRole('button', { name: 'Theme' }));
  await expect(canvas.queryByRole('textbox', { name: 'Site title' })).not.toBeInTheDocument();
  await expect(canvas.queryByRole('textbox', { name: 'Home page' })).not.toBeInTheDocument();
  await userEvent.click(canvas.getByRole('button', { name: 'Home' }));
  await expect(canvas.getByRole('textbox', { name: 'Site title' })).toHaveValue('Unsaved harbor title');
  await expect(canvas.getByRole('textbox', { name: 'Home page' })).toHaveValue('An unsaved home page body');

  await userEvent.click(canvas.getByRole('button', { name: 'Switch author' }));
  await expect(canvas.getByRole('textbox', { name: 'Site title' })).toHaveValue(title.value);
  await expect(canvas.getByRole('textbox', { name: 'Home page' })).toHaveValue(body.value);
  await expect(canvas.getByRole('status')).toHaveTextContent('All changes saved');
  await userEvent.click(canvas.getByRole('button', { name: 'Switch author' }));
  await expect(canvas.getByRole('textbox', { name: 'Site title' })).toHaveValue('Unsaved harbor title');
  await expect(canvas.getByRole('textbox', { name: 'Home page' })).toHaveValue('An unsaved home page body');
  await expect(canvas.getByRole('status')).toHaveTextContent('Unsaved sections: home, navigation');
  await expect(storageFailures).toBeGreaterThan(0);
};

export const SessionStorageUnavailable: Story = { play: verifiesDraftContinuity };
export const SessionStorageQuotaExhausted: Story = {
  args: { storageFailure: 'quota' },
  play: verifiesDraftContinuity,
};

const commandCalls: { key: string; body: string }[] = [];
let commandReplies = 0;
function CommandFields() {
  const [state, setState, ready] = useZoneEditorDraft('home', body, isDirty, accepts);
  const lane = useZoneEditorRef<ReturnType<typeof commandLane<TextDraft, WriteResult<string>>> | null>('story-save-lane', null);
  const captured = useZoneEditorRef<TextDraft | null>('story-save-choice', null);
  lane.current ??= commandLane({ ok: false, failure: 'unavailable' });
  async function save() {
    captured.current ??= { ...state };
    await lane.current!.submit(captured.current, (chosen, round) => commitCommand(round, async key => {
      commandCalls.push({ key, body: chosen.value });
      commandReplies += 1;
      if (commandReplies <= 2) return { ok: false, failure: 'unavailable' };
      setState(current => ({ ...current, savedValue: chosen.value }));
      captured.current = null;
      return { ok: true, data: chosen.value };
    }));
  }
  return <div className="grid gap-3">
    <label className="grid gap-2">Command body
      <textarea className={fieldClass} value={state.value} disabled={!ready}
        onChange={event => setState(current => ({ ...current, value: event.target.value }))} />
    </label>
    <p role="status">Confirmed body: {state.savedValue}</p>
    <button className={buttonClass} disabled={!ready} onClick={() => void save()}>Retry saved command</button>
  </div>;
}

function CommandSections() {
  const [section, setSection] = useState('home');
  return <>
    <nav className="flex gap-2"><button className={buttonClass} onClick={() => setSection('home')}>Home</button>
      <button className={buttonClass} onClick={() => setSection('theme')}>Theme</button></nav>
    {section === 'home' ? <CommandFields /> : <p>Theme section</p>}
  </>;
}

export const UnresolvedCommandRetainsItsEnvelopeAcrossSections: Story = {
  render() {
    commandCalls.length = 0;
    commandReplies = 0;
    return <main className="mx-auto grid max-w-2xl gap-4 p-6">
      <h1 className="font-semibold text-xl">Retry the original saved command</h1>
      <ZoneEditorDraftProvider zoneId="command-harbor" actingSubject="author"><CommandSections /></ZoneEditorDraftProvider>
    </main>;
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const field = await canvas.findByRole('textbox', { name: 'Command body' });
    await userEvent.clear(field);
    await userEvent.type(field, 'Original submitted body');
    await userEvent.click(canvas.getByRole('button', { name: 'Retry saved command' }));
    await waitFor(() => expect(commandCalls).toHaveLength(2));
    await userEvent.clear(field);
    await userEvent.type(field, 'Later local typing');
    await userEvent.click(canvas.getByRole('button', { name: 'Theme' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Home' }));
    await expect(canvas.getByRole('textbox', { name: 'Command body' })).toHaveValue('Later local typing');
    await userEvent.click(canvas.getByRole('button', { name: 'Retry saved command' }));
    await waitFor(() => expect(commandCalls).toHaveLength(3));
    await expect(commandCalls[2]).toEqual(commandCalls[0]);
    await expect(canvas.getByRole('status')).toHaveTextContent('Confirmed body: Original submitted body');
    await expect(canvas.getByRole('textbox', { name: 'Command body' })).toHaveValue('Later local typing');
  },
};

function ExitDraftField({ section }: { section: ZoneEditorSection }) {
  const [state, setState, ready] = useZoneEditorDraft(section, { value: '', savedValue: '' }, isDirty, accepts);
  const current = useZoneEditorRef(`exit-story:${section}`, state);
  current.current = state;
  useZoneEditorExitActions(section, async () => {
    setState(value => ({ ...value, savedValue: value.value }));
    return true;
  }, () => setState(value => ({ ...value, value: value.savedValue })));
  return <label className="grid gap-2">{section} draft
    <input className={fieldClass} disabled={!ready} value={state.value}
      onChange={event => setState(value => ({ ...value, value: event.target.value }))} />
  </label>;
}

function ExitJourney() {
  const [section, setSection] = useState<'home' | 'navigation' | 'theme'>('home');
  const [destination, setDestination] = useState('editor');
  const unsaved = useUnsavedZoneEditorSections();
  const requestExit = useZoneEditorExit();
  return <>
    <nav className="flex flex-wrap gap-2">{(['home', 'navigation', 'theme'] as const).map(name =>
      <button key={name} className={buttonClass} onClick={() => { setSection(name); setDestination('editor'); }}>{name}</button>)}</nav>
    <p role="status">{unsaved.length ? `Unsaved sections: ${unsaved.join(', ')}` : 'All changes saved'}</p>
    {destination === 'editor' ? <ExitDraftField section={section} /> : <p>{destination}</p>}
    <div className="flex flex-wrap gap-2">
      <button className={buttonClass} onClick={() => requestExit(() => setDestination('Saved preview'))}>Preview saved site</button>
      <button className={buttonClass} onClick={() => requestExit(() => setDestination('Retired site'))}>Confirm lifecycle exit</button>
    </div>
  </>;
}

const checksExitGuard: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  for (const section of ['home', 'navigation', 'theme']) {
    await userEvent.click(canvas.getByRole('button', { name: new RegExp(`^${section}$`) }));
    await userEvent.type(canvas.getByRole('textbox', { name: `${section} draft` }), `Unsaved ${section} choices`);
  }
  await userEvent.click(canvas.getByRole('button', { name: 'Preview saved site' }));
  const screen = within(document.body);
  await userEvent.click(await screen.findByRole('button', { name: 'Keep editing' }));
  for (const section of ['home', 'navigation', 'theme']) {
    await userEvent.click(canvas.getByRole('button', { name: new RegExp(`^${section}$`) }));
    await expect(canvas.getByRole('textbox', { name: `${section} draft` })).toHaveValue(`Unsaved ${section} choices`);
  }
  await userEvent.click(canvas.getByRole('button', { name: 'Confirm lifecycle exit' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Keep editing' }));
  await expect(canvas.getByRole('textbox', { name: 'theme draft' })).toHaveValue('Unsaved theme choices');
  await userEvent.click(canvas.getByRole('button', { name: 'Preview saved site' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Save changes and continue' }));
  await expect(await canvas.findByText('Saved preview')).toBeVisible();
  await expect(canvas.getByRole('status')).toHaveTextContent('All changes saved');
  await userEvent.click(canvas.getByRole('button', { name: /^home$/ }));
  await expect(canvas.getByRole('textbox', { name: 'home draft' })).toHaveValue('Unsaved home choices');
  await expect(storageFailures).toBeGreaterThan(0);
};

export const UnavailableStorageGuardsEveryDirtySection: Story = {
  render: () => <main className="mx-auto grid max-w-2xl gap-4 p-6"><h1>Keep work when leaving the editor</h1>
    <ZoneEditorDraftProvider zoneId="exit-unavailable" actingSubject="author"><ExitJourney /></ZoneEditorDraftProvider></main>,
  play: checksExitGuard,
};

export const FullStorageGuardsEveryDirtySection: Story = {
  ...UnavailableStorageGuardsEveryDirtySection,
  args: { storageFailure: 'quota' },
};

export const UnsavedDocumentExitChoices: Story = {
  ...UnavailableStorageGuardsEveryDirtySection,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByRole('textbox', { name: 'home draft' }), 'Unsaved home choices');
    await userEvent.click(canvas.getByRole('button', { name: 'Preview saved site' }));
    const screen = within(document.body);
    const dialog = await screen.findByRole('dialog', { name: 'Save your unsaved work before leaving?' });
    await waitFor(() => expect(dialog).toBeVisible());
    await expect(screen.getByRole('button', { name: 'Save changes and continue' })).toBeVisible();
    await expect(screen.getByRole('button', { name: 'Discard changes and continue' })).toBeVisible();
    await expect(screen.getByRole('button', { name: 'Keep editing' })).toBeVisible();
  },
};

export const UnsavedDocumentExitChoicesPhone: Story = {
  ...UnsavedDocumentExitChoices,
  globals: { viewport: { value: 'phone' } },
};
