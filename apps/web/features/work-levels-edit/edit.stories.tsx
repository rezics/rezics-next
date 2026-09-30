import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { EditFrame, NoAuthority } from './edit-frame.tsx';
import { RealizationEditor, ReleaseEditor } from './editions-editor.tsx';
import * as fixture from './fixtures.ts';
import { copyOf, messages } from './messages.ts';
import { PartsEditor } from './parts-editor.tsx';
import { RelationEditor } from './relation-editor.tsx';
import type { WriteState } from './write.ts';

type Answer = (form: FormData) => WriteState;
const done: Answer = () => ({ status: 'done', receipt: 'receipt-0193', replayed: false, nonce: crypto.randomUUID() });
const stale: Answer = form => ({ status: 'error', problem: 'stale', detail: 'Expected composition head is stale', field: null,
  values: Object.fromEntries([...form.entries()].filter((entry): entry is [string, string] => typeof entry[1] === 'string')) });
const asAction = (answer: Answer) => async (_previous: WriteState, form: FormData) => answer(form);

function Page({ locale, allowed, section, answer }: { locale: UiLocale; allowed: readonly string[];
  section: 'parts' | 'relations' | 'editions'; answer: Answer }) {
  const t = copyOf(locale);
  const action = asAction(answer);
  return <div className="mx-auto max-w-[46rem] px-4 py-8 sm:px-8">
    <EditFrame workRef="new-testament" title="A Certain Magical Index: New Testament" current={section} t={t}>
      {allowed.includes(fixture.editAction) ? <section className="grid gap-4" aria-labelledby="section">
        <h2 id="section" className="font-semibold text-xl">{t.editStructure}</h2>
        {section === 'parts' ? <PartsEditor work={fixture.work} structure={fixture.structure} head={fixture.head}
          parts={fixture.parts} allowed={allowed} locale={locale} action={action} messages={messages[locale]} load={fixture.loadWorks} /> : null}
        {section === 'relations' ? <RelationEditor work={fixture.work} mainVersion={fixture.mainVersion}
          head={fixture.mainRevision} kinds={fixture.kinds} allowed={allowed} locale={locale} action={action} messages={messages[locale]}
          load={fixture.loadWorks} /> : null}
        {section === 'editions' ? <div className="grid gap-6">
          <RealizationEditor work={fixture.work} mainVersion={fixture.mainVersion} mainRevision={fixture.mainRevision}
            existing={fixture.realizations} allowed={allowed} locale={locale} action={action} messages={messages[locale]} />
          <ReleaseEditor work={fixture.work} own={fixture.realizations} allowed={allowed} locale={locale} action={action} messages={messages[locale]}
            load={fixture.loadRealizations} loadWorks={fixture.loadWorks} /></div> : null}
      </section> : <NoAuthority workRef="new-testament" signedIn signInHref="/auth/start" t={t} />}
    </EditFrame>
  </div>;
}

const meta = { title: 'Work levels edit/Editors', component: Page,
  args: { locale: 'en', allowed: [fixture.editAction], section: 'parts', answer: done } } satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

const noOverflow = () => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

/** An editor adds "22 Reverse" after "22": the Work is found by title, and Main's receipt is shown. */
export const AddAPart: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const form = canvas.getByRole('form', { name: 'Add a part' });
    await userEvent.type(within(form).getByRole('textbox', { name: /Work/ }), 'New Test');
    await userEvent.click(await within(form).findByRole('button', { name: 'New Testament 22 Reverse' }));
    await userEvent.type(within(form).getByRole('textbox', { name: 'Label' }), '22 Reverse');
    await userEvent.selectOptions(within(form).getByRole('combobox', { name: 'Place' }), 'After 22');
    await userEvent.click(within(form).getByRole('button', { name: 'Add part' }));
    await expect(await canvas.findByText(/receipt-0193/)).toBeVisible();
    await noOverflow();
  },
};

/** Each part moves one place; the first has no "up" and the last no "down", rather than a disabled fake. */
export const Reorder: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('button', { name: 'Move 1 up' })).toBeNull();
    await expect(canvas.queryByRole('button', { name: 'Move SS1 down' })).toBeNull();
    await expect(canvas.getByRole('button', { name: 'Move 22 up' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Move 22 down' }));
    await expect(await canvas.findByText(/receipt-0193/)).toBeVisible();
  },
};

/** A second tab changed the list first: Main's refusal is shown, the typed label stays and the editor can reload. */
export const StaleHead: Story = { args: { answer: stale },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const form = canvas.getByRole('form', { name: 'Add a part' });
    await userEvent.type(within(form).getByRole('textbox', { name: 'Label' }), '22 Reverse');
    await userEvent.click(within(form).getByRole('button', { name: 'Add part' }));
    const alert = await canvas.findByRole('alert');
    await expect(alert).toHaveTextContent('This Work changed since you opened the page');
    await expect(alert).toHaveTextContent('Expected composition head is stale');
    await expect(within(alert).getByRole('button', { name: 'Reload latest' })).toBeVisible();
    await expect(within(form).getByRole('textbox', { name: 'Label' })).toHaveValue('22 Reverse');
  } };

/** A reader, or anyone without edit authority, gets no control at all, and a way back. */
export const ReaderSeesNoControls: Story = { args: { allowed: ['work.read'] },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'You can’t edit this Work' })).toBeVisible();
    await expect(canvasElement.querySelectorAll('form, input, select, textarea, button')).toHaveLength(0);
  } };

export const RecordRelation: Story = { args: { section: 'relations' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const form = canvas.getByRole('form', { name: 'Record a relation' });
    // Every relation's words are Main's rendering, none the page's own.
    await expect(within(form).getByRole('option', { name: 'Sequel to' })).toBeVisible();
    await userEvent.selectOptions(within(form).getByRole('combobox', { name: 'This Work is' }), 'Sequel to');
    await userEvent.type(within(form).getByRole('textbox', { name: 'The other Work' }), '01944100-0000-7000-8000-000000000031');
    await userEvent.type(within(form).getByRole('textbox', { name: /Evidence/ }), 'https://example.com/sequel');
    await userEvent.click(within(form).getByRole('button', { name: 'Record relation' }));
    await expect(await canvas.findByText(/receipt-0193/)).toBeVisible();
  } };

export const RealizationAndRelease: Story = { args: { section: 'editions' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const release = canvas.getByRole('form', { name: 'Add a release' });
    await expect(within(release).getByRole('checkbox', { name: /ja/ })).toBeVisible();
    await userEvent.type(within(release).getByRole('textbox', { name: 'Cover another Work’s realizations' }),
      '01944100-0000-7000-8000-000000000031');
    await userEvent.click(within(release).getByRole('button', { name: 'Load its realizations' }));
    await expect(await within(release).findByText('Realizations of New Testament 22 Reverse')).toBeVisible();
    await noOverflow();
  } };

export const Phone: Story = { args: { section: 'parts' }, globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('form', { name: 'Add a part' })).toBeVisible();
    await noOverflow();
  } };

export const PhoneEditions: Story = { args: { section: 'editions', locale: 'ja' }, globals: { viewport: { value: 'phone' } },
  async play() { await noOverflow(); } };
