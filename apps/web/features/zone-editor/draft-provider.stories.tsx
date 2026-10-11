import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { ZoneEditorDraftProvider, useUnsavedZoneEditorSections, useZoneEditorDraft } from './draft-provider.tsx';
import type { DraftStorage } from './draft-state.ts';

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
