import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { acting, header } from '../manage/fixtures.ts';
import { messages as manageMessages } from '../manage/messages.ts';
import { RealmFrame } from '../manage/realm-frame.tsx';
import { messages as editorMessages } from '../showcase-editor/messages.ts';
import { uploads } from '../showcase-editor/fixtures.ts';
import { messages as pickerMessages } from '../work-levels-edit/messages.ts';
import { ZoneShowcaseEditor, type ZoneShowcaseEditorProps } from './editor.tsx';
import { actingSubject, answers, documentOf, drawnFile, loadWorks, realm, registry, revision, works, zone } from './fixtures.ts';
import { copyOf, messages } from './messages.ts';
import { SectionHeader } from '../manage/parts.tsx';

type Args = {
  locale: UiLocale; case: 'empty' | 'full' | 'scheduled' | 'six'; save: ZoneShowcaseEditorProps['save'];
  addArt: ZoneShowcaseEditorProps['addArt']; readLatest: ZoneShowcaseEditorProps['readLatest'];
  upload: NonNullable<ZoneShowcaseEditorProps['upload']>;
};

function Page({ locale, case: kind, save, addArt, readLatest, upload }: Args) {
  const t = copyOf(locale);
  return <RealmFrame realm={zone} address="games" header={header} agent={acting} settingsAllowed locale={locale} messages={manageMessages}>
    <section aria-labelledby="showcase-heading" className="grid gap-6">
      <SectionHeader id="showcase-heading" title={t.heading} description={t.intro} />
      <ZoneShowcaseEditor zone={zone} realm={realm} actingSubject={actingSubject} locale={locale} head={revision}
        stored={{ kind: 'document', document: documentOf(kind) }} registry={registry} works={works} heroTitle="Featured"
        messages={messages[locale]} editorMessages={editorMessages[locale]} pickerMessages={pickerMessages[locale]}
        save={save} addArt={addArt} readWorks={answers.works as ZoneShowcaseEditorProps['readWorks']} readLatest={readLatest}
        upload={upload as never} loadWorks={loadWorks} now={Date.parse('2026-10-05T09:00:00.000Z')} />
    </section>
  </RealmFrame>;
}

const meta = {
  title: 'Showcase editor/Zone showcase',
  component: Page,
  args: { locale: 'en', case: 'full', save: answers.saved as Args['save'], addArt: answers.art as Args['addArt'],
    readLatest: answers.latest() as Args['readLatest'], upload: uploads({ status: 'cleared', asset: '01a0e3d1-0000-7000-8000-0000000000ff' }) as Args['upload'] },
  parameters: { route: { pathname: '/en/manage/r/games/showcase' } },
  async afterEach({ id }) {
    if (import.meta.env.VITE_SHOWCASE_EDITOR_VISUAL !== '1') return;
    const { page } = await import('vitest/browser');
    await document.fonts.ready;
    await new Promise(resolve => setTimeout(resolve, 600));
    await page.viewport(innerWidth, Math.max(innerHeight, document.documentElement.scrollHeight));
    await new Promise(resolve => setTimeout(resolve, 400));
    await page.screenshot({ path: `../../../../.temp/showcase-zone-editor/${id}.png` });
  },
} satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

const phone = { viewport: { value: 'phone' } };
const tablet = { viewport: { value: 'tabletPortrait' } };
const desktop = { viewport: { value: 'desktop' } };
/** Nothing makes the page wider than its window; a failure names what sticks out. */
const noOverflow = () => {
  const wide = [...document.querySelectorAll<HTMLElement>('body *')].filter(element => element.getBoundingClientRect().right > window.innerWidth + 1
    && !element.closest('.overflow-x-auto')).slice(0, 6).map(element => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 70)}`);
  return expect(document.documentElement.scrollWidth, wide.join(' | ')).toBeLessThanOrEqual(window.innerWidth);
};
const slides = (canvas: ReturnType<typeof within>, locale: UiLocale = 'en') => within(canvas.getByRole('list', { name: copyOf(locale).listLabel }));
const saveButton = (canvas: ReturnType<typeof within>) => canvas.getByRole('button', { name: 'Save showcase' });
/** The stage inside the preview's iframe, once React has rendered into it. */
async function stage(canvasElement: HTMLElement) {
  const frame = canvasElement.querySelector<HTMLIFrameElement>('iframe[title^="Showcase preview"]')!;
  await waitFor(() => expect(frame.contentDocument?.querySelector('.showcase-slide')).toBeTruthy(), { timeout: 5000 });
  return frame.contentDocument!;
}

/** A Zone with no slides: it says what readers see instead, and the stage waits for the first slide. */
export const Empty: Story = {
  args: { case: 'empty' },
  globals: desktop,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('No slides yet')).toBeVisible();
    await expect(canvas.getByText(/shows the Realm’s newest picks/)).toBeVisible();
    await expect(canvas.getByText('Add a slide to see the stage.')).toBeVisible();
    await expect(canvas.getByText('Everything is saved')).toBeVisible();
    await expect(saveButton(canvas)).toBeDisabled();
    await noOverflow();
  },
};
export const EmptyPhone: Story = { ...Empty, globals: phone };

/** Adding a Work by search puts it first, marked as the slide most readers act on; saving names the revision the page started from. */
export const AddAWork: Story = {
  args: { case: 'empty' },
  globals: desktop,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Add a Work' }));
    await userEvent.type(canvas.getByRole('textbox', { name: 'Add a Work to the showcase' }), 'Astral');
    await userEvent.click(await canvas.findByRole('button', { name: 'Astral Tide' }));
    await expect(slides(canvas).getByText('Most readers act on this slide')).toBeVisible();
    await expect(slides(canvas).getByText('Built from the cover')).toBeVisible();
    await expect(canvas.getByText('1 of 6 slides')).toBeVisible();
    // The Zone's layout had a showcase area; nothing is added behind the person's back.
    await expect(canvas.queryByText(/has no showcase area/)).toBeNull();
    const doc = await stage(canvasElement);
    await expect(doc.querySelector('.showcase-cover-slide')).toBeTruthy();
    await userEvent.click(saveButton(canvas));
    await expect(await canvas.findByText('Saved. The Zone’s home page now shows these slides.')).toBeVisible();
    await expect(canvas.getByText('Everything is saved')).toBeVisible();
    await expect(saveButton(canvas)).toBeDisabled();
  },
};

/** Five slides: a Work with art of its own, a link slide with campaign art, Works built from their covers. */
export const Full: Story = {
  globals: desktop,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const list = slides(canvas);
    await expect(list.getAllByRole('listitem')).toHaveLength(5);
    await expect(list.getAllByText('Most readers act on this slide')).toHaveLength(1);
    await expect(list.getByText('The Work’s art')).toBeVisible();
    await expect(list.getByText('Art for this Zone')).toBeVisible();
    await expect(list.getAllByText('Built from the cover')).toHaveLength(3);
    await expect(canvas.getByText('5 of 6 slides')).toBeVisible();
    const doc = await stage(canvasElement);
    await expect(doc.querySelectorAll('.showcase-slide')).toHaveLength(5);
    await noOverflow();
  },
};
export const FullPhone: Story = { ...Full, globals: phone };
export const FullTablet: Story = { ...Full, globals: tablet };
export const FullTraditionalChinese: Story = { args: { locale: 'zh-Hant' }, globals: { ...desktop, locale: 'zh-Hant' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 2, name: '展示' })).toBeVisible();
    await expect(slides(canvas, 'zh-Hant').getAllByText('多數讀者會點這一張')).toHaveLength(1);
    await noOverflow();
  } };
export const FullTraditionalChinesePhone: Story = { ...FullTraditionalChinese, globals: { ...phone, locale: 'zh-Hant' } };
export const FullTraditionalChineseTablet: Story = { ...FullTraditionalChinese, globals: { ...tablet, locale: 'zh-Hant' } };
export const FullJapanesePhone: Story = { args: { locale: 'ja' }, globals: { ...phone, locale: 'ja' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(slides(canvas, 'ja').getAllByText('多くの読者が選ぶスライド')).toHaveLength(1);
    await expect(canvas.getByRole('button', { name: 'ショーケースを保存' })).toBeDisabled();
    await noOverflow();
  } };

/** A slide moves with its own buttons (which a keyboard reaches), and the order is announced. */
export const Reorder: Story = {
  globals: desktop,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const names = () => slides(canvas).getAllByRole('button', { name: /^Edit / }).map(button => button.getAttribute('aria-label'));
    await expect(names().slice(0, 3)).toEqual(['Edit Hades', 'Edit Krita', 'Edit Autumn serial contest']);
    await expect(canvas.getByRole('button', { name: 'Move Hades up' })).toBeDisabled();
    const down = canvas.getByRole('button', { name: 'Move Hades down' });
    down.focus();
    await userEvent.keyboard('{Enter}');
    await expect(names().slice(0, 3)).toEqual(['Edit Krita', 'Edit Hades', 'Edit Autumn serial contest']);
    await expect(await canvas.findByText('Hades is now slide 2 of 5')).toBeInTheDocument();
    await expect(slides(canvas).getAllByText('Most readers act on this slide')).toHaveLength(1);
    await expect(within(slides(canvas).getAllByRole('listitem')[0]!).getByText('Most readers act on this slide')).toBeVisible();
    await expect(canvas.getByText('Unsaved changes')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Discard changes' }));
    await expect(names().slice(0, 2)).toEqual(['Edit Hades', 'Edit Krita']);
    await expect(canvas.getByText('Everything is saved')).toBeVisible();
  },
};

/** Six slides is the limit; the sixth names a Work readers cannot see, and the list says so. */
export const SixSlides: Story = {
  args: { case: 'six' },
  globals: desktop,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('6 of 6 slides')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Add a Work' })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: 'Add a link' })).toBeDisabled();
    await expect(canvas.getByText(/A showcase holds six slides/)).toBeVisible();
    await waitFor(() => expect(slides(canvas).getByText(/Readers can’t see this slide/)).toBeVisible());
    await noOverflow();
  },
};

/** Schedules: live, ongoing and upcoming slides say so; an end before the start is refused where it is typed, and saving waits. */
export const Scheduled: Story = {
  args: { case: 'scheduled' },
  globals: desktop,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(slides(canvas).getByText(/^Until /)).toBeVisible();
    await expect(slides(canvas).getByText(/^Starts /)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Edit Krita' }));
    const until = canvas.getByLabelText('Shown until');
    await userEvent.clear(until);
    await userEvent.type(until, '2026-01-01T00:00');
    await expect(await canvas.findByText('The end must come after the start.')).toBeVisible();
    await expect(slides(canvas).getByText('Needs attention')).toBeVisible();
    await expect(saveButton(canvas)).toBeDisabled();
    await expect(canvas.getByText('Fix the marked fields to save.')).toBeVisible();
    await userEvent.click(canvas.getAllByRole('button', { name: 'Clear' })[1]!);
    await waitFor(() => expect(saveButton(canvas)).toBeEnabled());
    await noOverflow();
  },
};
export const ScheduledPhone: Story = { ...Scheduled, globals: phone };
export const ScheduledTablet: Story = { ...Scheduled, globals: tablet };

/** A link slide needs an address on this site and a title; the words are checked as they are typed. */
export const LinkSlide: Story = {
  args: { case: 'empty' },
  globals: desktop,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Add a link' }));
    await expect(await canvas.findByText('Enter an address.')).toBeVisible();
    await userEvent.type(canvas.getByRole('textbox', { name: /^Address on this site/ }), 'fiction');
    await expect(canvas.getByText(/Start with a single “\/”/)).toBeVisible();
    await userEvent.clear(canvas.getByRole('textbox', { name: /^Address on this site/ }));
    await userEvent.type(canvas.getByRole('textbox', { name: /^Address on this site/ }), '/discover');
    await userEvent.type(canvas.getByRole('textbox', { name: /^Title Shown/ }), 'Autumn serial contest');
    await expect(canvas.queryByText('Needs attention')).toBeNull();
    await expect(saveButton(canvas)).toBeEnabled();
    await expect(slides(canvas).getByText('No art')).toBeVisible();
  },
};

/** Choosing a background shows it framed at once; adding it uploads and screens the file, makes it the Realm's campaign art, and the slide then uses it. */
export const AddCampaignArt: Story = {
  args: { case: 'full' },
  globals: desktop,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Edit Krita' }));
    await expect(canvas.getByText(/This slide is built from the Work’s cover/)).toBeVisible();
    const landscape = within(canvas.getByRole('heading', { name: 'Landscape · 16:9' }).closest('section')!);
    const input = landscape.getByRole('button', { name: 'Choose an image' }).parentElement!.querySelector('input[type=file]')!;
    await userEvent.upload(input as HTMLInputElement, await drawnFile(1920, 1080, 'image/jpeg', 'sea.jpg'));
    await expect(await landscape.findByRole('group', { name: 'Frame, 1920 × 1080 pixels' })).toBeVisible();
    await expect(landscape.getByText('Not added yet')).toBeVisible();
    // An image that is not added keeps the showcase from being saved: the person adds or discards it first.
    await expect(canvas.getByText(/1 image hasn’t been added to its slide yet/)).toBeVisible();
    await expect(saveButton(canvas)).toBeDisabled();
    await userEvent.click(landscape.getByRole('button', { name: 'Use for this slide' }));
    await expect(await landscape.findByText(/Checking the image/)).toBeVisible();
    await expect(await landscape.findByText(/Added to this slide/, {}, { timeout: 4000 })).toBeVisible();
    await expect(landscape.getByText('On this slide')).toBeVisible();
    await waitFor(() => expect(slides(canvas).getAllByText('Art for this Zone')).toHaveLength(2));
    await expect(canvas.getByText(/This slide uses art made for this Zone/)).toBeVisible();
    await waitFor(() => expect(saveButton(canvas)).toBeEnabled());
    await noOverflow();
  },
};
export const AddCampaignArtPhone: Story = { ...AddCampaignArt, globals: phone };
/** The author calls a new slide image adult content before adding it: the same choice and words as the Work's art editor, and the upload carries the mark. */
const sent: (boolean | undefined)[] = [];
export const AddAdultCampaignArt: Story = {
  args: { case: 'full', upload: (async (input: Parameters<ReturnType<typeof uploads>>[0] & { adult?: boolean }) => {
    sent.push(input.adult);
    return uploads({ status: 'cleared', asset: '01a0e3d1-0000-7000-8000-0000000000ff' })(input);
  }) as never },
  globals: desktop,
  async play({ canvasElement }) {
    sent.length = 0;
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Edit Krita' }));
    const landscape = within(canvas.getByRole('heading', { name: 'Landscape · 16:9' }).closest('section')!);
    const input = landscape.getByRole('button', { name: 'Choose an image' }).parentElement!.querySelector('input[type=file]')!;
    await userEvent.upload(input as HTMLInputElement, await drawnFile(1920, 1080, 'image/jpeg', 'sea.jpg'));
    await userEvent.click(await landscape.findByRole('checkbox', { name: 'This image is adult content' }));
    await expect(landscape.getByText(/hidden-image icon here instead of the image/)).toBeVisible();
    await userEvent.click(landscape.getByRole('button', { name: 'Use for this slide' }));
    await expect(await landscape.findByText(/Added to this slide/, {}, { timeout: 4000 })).toBeVisible();
    await expect(sent).toEqual([true]);
    await noOverflow();
  },
};

export const AddCampaignArtTablet: Story = { ...AddCampaignArt, globals: tablet };
export const AddCampaignArtTraditionalChinese: Story = { ...AddCampaignArt, args: { locale: 'zh-Hant' }, globals: { ...desktop, locale: 'zh-Hant' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '編輯「Krita」' }));
    const landscape = within(canvas.getByRole('heading', { name: '橫向 · 16:9' }).closest('section')!);
    const input = landscape.getByRole('button', { name: '選擇圖片' }).parentElement!.querySelector('input[type=file]')!;
    await userEvent.upload(input as HTMLInputElement, await drawnFile(1920, 1080, 'image/jpeg', 'sea.jpg'));
    await userEvent.click(await landscape.findByRole('button', { name: '用於這張投影片' }));
    await expect(await landscape.findByText(/已加入這張投影片/, {}, { timeout: 4000 })).toBeVisible();
    await noOverflow();
  } };

/** An image smaller than the role's minimum is refused before upload, with its size and the minimum. */
export const ArtTooSmall: Story = {
  globals: desktop,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Edit Krita' }));
    const portrait = within(canvas.getByRole('heading', { name: 'Portrait · 3:4' }).closest('section')!);
    const input = portrait.getByRole('button', { name: 'Choose an image' }).parentElement!.querySelector('input[type=file]')!;
    await userEvent.upload(input as HTMLInputElement, await drawnFile(600, 800, 'image/jpeg', 'small.jpg'));
    await expect(await portrait.findByRole('alert')).toHaveTextContent('This image is 600 × 800 pixels; this art needs at least 960 × 1280.');
  },
};

/** The screening or the Zone refuses an image: it is said where the image was chosen, in words that name what to do. */
export const ArtRefused: Story = {
  args: { addArt: answers.artRefused('denied') as Args['addArt'] },
  globals: desktop,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Edit Krita' }));
    const landscape = within(canvas.getByRole('heading', { name: 'Landscape · 16:9' }).closest('section')!);
    const input = landscape.getByRole('button', { name: 'Choose an image' }).parentElement!.querySelector('input[type=file]')!;
    await userEvent.upload(input as HTMLInputElement, await drawnFile(1920, 1080, 'image/jpeg', 'sea.jpg'));
    await userEvent.click(await landscape.findByRole('button', { name: 'Use for this slide' }));
    await expect(await landscape.findByRole('alert')).toHaveTextContent('You can’t add campaign art to this Zone');
    await expect(landscape.getByText('Not added yet')).toBeVisible();
  },
};

/** The campaign art of a slide is removed: the Work's art (or the cover) serves again once the showcase is saved. */
export const RemoveCampaignArt: Story = {
  globals: desktop,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Edit Autumn serial contest' }));
    const landscape = within(canvas.getByRole('heading', { name: 'Landscape · 16:9' }).closest('section')!);
    await expect(landscape.getByText('On this slide')).toBeVisible();
    await userEvent.click(landscape.getByRole('button', { name: 'Remove' }));
    await expect(landscape.getByText('Not set')).toBeVisible();
    await expect(slides(canvas).queryAllByText('Art for this Zone')).toHaveLength(0);
    await expect(canvas.getByText('Unsaved changes')).toBeVisible();
  },
};

/** The title effect applies to every slide and is drawn live on a sample. */
export const TitleEffect: Story = {
  globals: desktop,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const sample = canvas.getByRole('img', { name: 'Sample: Glow' });
    await expect(sample.querySelector('[data-effect=glow]')).toBeTruthy();
    await userEvent.click(canvas.getByRole('radio', { name: 'Gradient' }));
    await expect(canvas.getByRole('img', { name: 'Sample: Gradient' }).querySelector('[data-effect=gradient]')).toBeTruthy();
    await expect(canvas.getByText('Unsaved changes')).toBeVisible();
    const doc = await stage(canvasElement);
    await waitFor(() => expect(doc.querySelector('.showcase-title[data-effect=gradient]')).toBeTruthy());
  },
};

/** The Zone refuses the document: Main's reason is shown after the sentence. */
export const Refused: Story = {
  args: { save: answers.refused('invalid', 'Zone slide schedule is empty') as Args['save'] },
  globals: desktop,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('radio', { name: 'Outline' }));
    await userEvent.click(saveButton(canvas));
    const alert = await canvas.findByRole('alert');
    await expect(alert).toHaveTextContent('This showcase wasn’t accepted.');
    await expect(alert).toHaveTextContent('Reason: Zone slide schedule is empty');
    await expect(saveButton(canvas)).toBeEnabled();
  },
};
export const RefusedPhone: Story = { ...Refused, globals: phone };

/** Someone changed the Zone meanwhile: nothing is overwritten, the person reloads, keeps their slides and saves on top. */
export const Conflict: Story = {
  args: { save: answers.refused('conflict') as Args['save'], readLatest: answers.latest('scheduled') as Args['readLatest'] },
  globals: desktop,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Move Hades down' }));
    await userEvent.click(saveButton(canvas));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(/Nothing was overwritten/);
    await userEvent.click(canvas.getByRole('button', { name: 'Reload latest' }));
    await expect(await canvas.findByText(/Reloaded\. The Zone’s latest showcase has 4 slides/)).toBeVisible();
    // The person's order stays, and the title effect they did not touch follows the Zone.
    await expect(slides(canvas).getAllByRole('button', { name: /^Edit / }).map(button => button.getAttribute('aria-label')).slice(0, 2))
      .toEqual(['Edit Krita', 'Edit Hades']);
    await expect(canvas.getByRole('radio', { name: 'Outline' })).toBeChecked();
    await expect(canvas.getByText('Unsaved changes')).toBeVisible();
    await expect(saveButton(canvas)).toBeEnabled();
  },
};
export const ConflictPhone: Story = { ...Conflict, globals: phone };

/** Without the authority to edit the Zone, Main refuses; the editor says what is missing and whom to ask. */
export const Denied: Story = {
  args: { save: answers.refused('denied') as Args['save'] },
  globals: desktop,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('radio', { name: 'Plain' }));
    await userEvent.click(saveButton(canvas));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(/needs the authority to edit the Zone/);
  },
};

