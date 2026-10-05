import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { EditFrame } from '../work-levels-edit/edit-frame.tsx';
import { copyOf as editCopy } from '../work-levels-edit/messages.ts';
import { editHref } from '../work-levels-edit/route.ts';
import { ShowcaseEditor, type ShowcaseEditorProps } from './editor.tsx';
import { answers, drawnFile, type FixtureArt, loadTitle, mainLike, opaquePng, savedFixture, uploads, work } from './fixtures.ts';
import { messages } from './messages.ts';

type Args = { art: FixtureArt; locale: UiLocale; saveArt: ShowcaseEditorProps['saveArt'];
  upload: NonNullable<ShowcaseEditorProps['upload']> };

function Page({ art, locale, saveArt, upload }: Args) {
  const t = messages[locale];
  return <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-10">
    <EditFrame workRef={work.id} title={work.title.value} current="showcase" t={editCopy(locale)}>
      <section className="grid gap-6" aria-labelledby="showcase-heading">
        <div className="grid gap-2">
          <h2 id="showcase-heading" className="font-semibold text-xl">{t.heading}</h2>
          <p className="max-w-3xl text-pretty text-muted-foreground text-sm">{t.intro}</p>
        </div>
        <ShowcaseEditor work={work} art={savedFixture(art)} actingSubject="https://rezics.com/id/01a0e3d1-0000-7000-8000-0000000000aa"
          locale={locale} messages={t} saveArt={saveArt} saveTrailer={answers.done} loadTitle={loadTitle} upload={upload as never} />
      </section>
    </EditFrame>
  </div>;
}

const meta = {
  title: 'Showcase editor/Editor',
  component: Page,
  args: { art: 'complete', locale: 'en', saveArt: answers.done as Args['saveArt'],
    upload: uploads({ status: 'cleared', asset: '01a0e3d1-0000-7000-8000-0000000000ff' }) as Args['upload'] },
  parameters: { route: { pathname: localizedPath(editHref(work.id, 'showcase'), 'en') } },
  async afterEach({ id }) {
    if (import.meta.env.VITE_SHOWCASE_EDITOR_VISUAL !== '1') return;
    const { page } = await import('vitest/browser');
    await document.fonts.ready;
    await new Promise(resolve => setTimeout(resolve, 600));
    // The whole page, at the story's width: a taller window does not change this page's layout.
    await page.viewport(innerWidth, Math.max(innerHeight, document.documentElement.scrollHeight));
    await new Promise(resolve => setTimeout(resolve, 400));
    await page.screenshot({ path: `../../../../.temp/showcase-editor/${id}.png` });
  },
} satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

const phone = { viewport: { value: 'phone' } };
const desktop = { viewport: { value: 'desktop' } };
const noOverflow = () => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
const panel = (canvas: ReturnType<typeof within>, name: string | RegExp) =>
  within(canvas.getByRole('heading', { name }).closest('section')!);
/** The stage inside the preview's iframe, once React has rendered into it. */
async function stage(canvasElement: HTMLElement) {
  const frame = canvasElement.querySelector<HTMLIFrameElement>('iframe[title^="Showcase preview"]')!;
  await waitFor(() => expect(frame.contentDocument?.querySelector('.showcase-slide')).toBeTruthy(), { timeout: 5000 });
  return frame.contentDocument!;
}

/** A Work with no art yet: every slot says what readers see instead, and the stage is built from the cover. */
export const Empty: Story = {
  args: { art: 'empty' },
  globals: desktop,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/the slide is built from the Work’s cover/)).toBeVisible();
    await expect(canvas.getByText(/phones show the slide built from the cover/)).toBeVisible();
    await expect(canvas.getByText(/No logos yet/)).toBeVisible();
    const doc = await stage(canvasElement);
    await expect(doc.querySelector('.showcase-cover-slide')).toBeTruthy();
    await noOverflow();
  },
};
export const EmptyPhone: Story = { ...Empty, globals: phone };

/** Landscape art with a focal area and no portrait art: the editor draws the cut phones will show and says so. */
export const Partial: Story = {
  args: { art: 'partial' },
  globals: desktop,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/Phones show the part of the landscape art marked “Phones”/)).toBeVisible();
    await expect(panel(canvas, 'Landscape · 16:9').getByText('Phones')).toBeVisible();
    await expect(panel(canvas, 'Landscape · 16:9').getByText('Saved')).toBeVisible();
    // Removing the focal area leaves phones nothing to cut around: they show the whole image.
    await userEvent.click(canvas.getByRole('button', { name: 'Remove the focal area' }));
    await expect(canvas.getByText(/Phones show the landscape art whole/)).toBeVisible();
    await expect(panel(canvas, 'Landscape · 16:9').getByText('Unsaved')).toBeVisible();
    await noOverflow();
  },
};
export const PartialPhone: Story = { ...Partial, globals: phone };

/** Every role, two logos and a trailer: the coverage table names which title languages get which logo. */
export const Complete: Story = {
  globals: desktop,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const coverage = within(canvas.getByRole('table'));
    await expect(coverage.getByRole('row', { name: /English English logo/ })).toBeVisible();
    await expect(coverage.getByRole('row', { name: /Japanese Japanese logo/ })).toBeVisible();
    await expect(coverage.getByRole('row', { name: /German Live title/ })).toBeVisible();
    await expect(canvas.getByText(/privacy-enhanced player/)).toBeVisible();
    const doc = await stage(canvasElement);
    await waitFor(() => expect(doc.querySelector('img.showcase-logo')).toBeTruthy());
    await expect(doc.querySelector('.showcase-coming')).toBeTruthy();
    await noOverflow();
  },
};
export const CompletePhone: Story = { ...Complete, globals: phone };
export const CompleteTraditionalChinese: Story = { args: { locale: 'zh-Hant' }, globals: { ...desktop, locale: 'zh-Hant' } };

/**
 * Choosing a background shows it framed at once; saving uploads it, waits for screening, then selects it. A second
 * change before the page reads Main again starts from the selection just recorded, so Main does not call it a conflict.
 */
export const ChooseAndSave: Story = {
  args: { art: 'empty', saveArt: mainLike(savedFixture('empty')) },
  globals: desktop,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const landscape = panel(canvas, 'Landscape · 16:9');
    const input = landscape.getByRole('button', { name: 'Choose an image' }).parentElement!.querySelector('input[type=file]')!;
    await userEvent.upload(input as HTMLInputElement, await drawnFile(1920, 1080, 'image/jpeg', 'sea.jpg'));
    await expect(await landscape.findByRole('group', { name: 'Frame, 1920 × 1080 pixels' })).toBeVisible();
    await expect(landscape.getByText('Unsaved')).toBeVisible();
    await userEvent.click(landscape.getByRole('button', { name: 'Mark the focal area' }));
    await expect(landscape.getByRole('group', { name: /Focal area/ })).toBeVisible();
    await userEvent.click(landscape.getByRole('button', { name: 'Save' }));
    await expect(await landscape.findByText(/Checking the image/)).toBeVisible();
    await expect(await landscape.findByText(/Saved\. Every Zone/, {}, { timeout: 4000 })).toBeVisible();
    await expect(landscape.getByText('Saved', { exact: true })).toBeVisible();
    await userEvent.click(landscape.getByRole('button', { name: 'Remove the focal area' }));
    await userEvent.click(landscape.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(landscape.getByText(/Saved\. Every Zone/)).toBeVisible());
    await expect(landscape.queryByRole('alert')).toBeNull();
  },
};

/** What each upload was told: whether the author called it adult content. */
const sent: (boolean | undefined)[] = [];
const recording = (outcome: Parameters<typeof uploads>[0]) => {
  const upload = uploads(outcome);
  return async (input: Parameters<typeof upload>[0] & { adult?: boolean }) => { sent.push(input.adult); return upload(input); };
};
const cleared = { status: 'cleared', asset: '01a0e3d1-0000-7000-8000-0000000000ff' } as const;

/**
 * An image the author leaves unmarked is classified on their device when it uploads, and what readers see follows that
 * result; the editor says so, and the upload carries no adult mark.
 */
export const ClassifiedUpload: Story = {
  args: { art: 'empty', saveArt: mainLike(savedFixture('empty')), upload: recording(cleared) as Args['upload'] },
  globals: desktop,
  async play({ canvasElement }) {
    sent.length = 0;
    const landscape = panel(within(canvasElement), 'Landscape · 16:9');
    const input = landscape.getByRole('button', { name: 'Choose an image' }).parentElement!.querySelector('input[type=file]')!;
    await userEvent.upload(input as HTMLInputElement, await drawnFile(1920, 1080, 'image/jpeg', 'sea.jpg'));
    await expect(await landscape.findByRole('checkbox', { name: 'This image is adult content' })).not.toBeChecked();
    await expect(landscape.getByText(/REZICS checks the image on your device when you upload it/)).toBeVisible();
    await userEvent.click(landscape.getByRole('button', { name: 'Save' }));
    await expect(await landscape.findByText(/Saved\. Every Zone/, {}, { timeout: 4000 })).toBeVisible();
    await expect(sent.map(Boolean)).toEqual([false]);
  },
};

/** The author calls the image adult content: the editor says readers who have not chosen to see such images get an icon, and the upload says so. */
export const AuthorMarkedAdult: Story = {
  args: { art: 'empty', saveArt: mainLike(savedFixture('empty')), upload: recording(cleared) as Args['upload'] },
  globals: desktop,
  async play({ canvasElement }) {
    sent.length = 0;
    const landscape = panel(within(canvasElement), 'Landscape · 16:9');
    const input = landscape.getByRole('button', { name: 'Choose an image' }).parentElement!.querySelector('input[type=file]')!;
    await userEvent.upload(input as HTMLInputElement, await drawnFile(1920, 1080, 'image/jpeg', 'sea.jpg'));
    await userEvent.click(await landscape.findByRole('checkbox', { name: 'This image is adult content' }));
    await expect(landscape.getByRole('checkbox', { name: 'This image is adult content' })).toBeChecked();
    await expect(landscape.getByText(/hidden-image icon here instead of the image/)).toBeVisible();
    await userEvent.click(landscape.getByRole('button', { name: 'Save' }));
    await expect(await landscape.findByText(/Saved\. Every Zone/, {}, { timeout: 4000 })).toBeVisible();
    await expect(sent).toEqual([true]);
  },
};
/** At 390 px the choice and its words fit the card without widening the page. */
export const AuthorMarkedAdultPhone: Story = {
  args: { art: 'empty' },
  globals: phone,
  async play({ canvasElement }) {
    const landscape = panel(within(canvasElement), 'Landscape · 16:9');
    const input = landscape.getByRole('button', { name: 'Choose an image' }).parentElement!.querySelector('input[type=file]')!;
    await userEvent.upload(input as HTMLInputElement, await drawnFile(1920, 1080, 'image/jpeg', 'sea.jpg'));
    await userEvent.click(await landscape.findByRole('checkbox', { name: 'This image is adult content' }));
    await expect(landscape.getByText(/hidden-image icon here instead of the image/)).toBeVisible();
    await noOverflow();
  },
};

/** In Japanese at 390 px the preview's window switch scrolls inside its own row instead of widening the page. */
export const JapanesePhone: Story = {
  args: { locale: 'ja' },
  globals: { ...phone, locale: 'ja' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const windows = canvas.getByRole('radiogroup', { name: 'ウィンドウ' });
    await expect(windows).toBeVisible();
    await expect(windows.parentElement!.scrollWidth).toBeGreaterThan(0);
    await noOverflow();
    await expect((windows.parentElement as HTMLElement).getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
  },
};

/** An image smaller than the role's minimum is refused before upload, with its size and the minimum. */
export const TooSmall: Story = {
  args: { art: 'partial' },
  globals: desktop,
  async play({ canvasElement }) {
    const portrait = panel(within(canvasElement), 'Portrait · 3:4');
    const input = portrait.getByRole('button', { name: 'Choose an image' }).parentElement!.querySelector('input[type=file]')!;
    await userEvent.upload(input as HTMLInputElement, await drawnFile(600, 800, 'image/jpeg', 'small.jpg'));
    await expect(await portrait.findByRole('alert')).toHaveTextContent('This image is 600 × 800 pixels; this art needs at least 960 × 1280.');
  },
};

/** A logo without an alpha channel is refused before upload, and the editor says why. */
export const LogoWithoutTransparency: Story = {
  args: { art: 'partial' },
  globals: desktop,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const add = panel(canvas, 'Add a logo');
    await userEvent.upload(add.getByRole('button', { name: 'Choose a logo file' }).parentElement!.querySelector('input[type=file]')!, opaquePng());
    const logo = within((await canvas.findByRole('heading', { name: 'Language-neutral · Light' })).closest('section')!);
    await expect(await logo.findByRole('alert')).toHaveTextContent(/no transparency \(no alpha channel\)/);
    await noOverflow();
  },
};
export const LogoWithoutTransparencyPhone: Story = { ...LogoWithoutTransparency, globals: phone };

/** Main refuses the frame: the refusal is said in words, with Main's reason. */
export const Refusal: Story = {
  args: { art: 'partial', saveArt: answers.refused('resolution', 'Showcase media does not meet the selected role') },
  globals: desktop,
  async play({ canvasElement }) {
    const landscape = panel(within(canvasElement), 'Landscape · 16:9');
    await userEvent.click(landscape.getByRole('button', { name: 'Remove the focal area' }));
    await userEvent.click(landscape.getByRole('button', { name: 'Save' }));
    const alert = await landscape.findByRole('alert');
    await expect(alert).toHaveTextContent('The framed area is smaller than the minimum size.');
    await expect(alert).toHaveTextContent('Reason: Showcase media does not meet the selected role');
  },
};
export const RefusalPhone: Story = { ...Refusal, globals: phone };

/** Someone changed the slot meanwhile: nothing is overwritten, and the person reloads to see it. */
export const Conflict: Story = {
  args: { art: 'complete', saveArt: answers.refused('conflict') },
  globals: desktop,
  async play({ canvasElement }) {
    const logo = panel(within(canvasElement), 'English · Light');
    await userEvent.click(logo.getByRole('button', { name: 'Remove' }));
    await expect(logo.getByText('Removed when you save')).toBeVisible();
    await userEvent.click(logo.getByRole('button', { name: 'Save' }));
    await expect(await logo.findByRole('alert')).toHaveTextContent(/Nothing was overwritten/);
    await userEvent.click(logo.getByRole('button', { name: 'Reload latest' }));
    await waitFor(() => expect(logo.queryByRole('alert')).toBeNull());
    await expect(logo.getByText('Removed when you save')).toBeVisible();
  },
};
export const ConflictPhone: Story = { ...Conflict, globals: phone };

/** Screening holds the image for staff review; the editor explains it and keeps the change. */
export const HeldForReview: Story = {
  args: { art: 'empty', upload: uploads({ status: 'refused', reason: 'held' }, ['uploading', 'screening', 'held']) },
  globals: desktop,
  async play({ canvasElement }) {
    const cutout = panel(within(canvasElement), 'Cutout');
    const input = cutout.getByRole('button', { name: 'Choose an image' }).parentElement!.querySelector('input[type=file]')!;
    await userEvent.upload(input as HTMLInputElement, await drawnFile(400, 600, 'image/png', 'hero.png'));
    await userEvent.click(await cutout.findByRole('button', { name: 'Save' }));
    await expect(await cutout.findByText(/held for review by REZICS staff/)).toBeVisible();
    await expect(await cutout.findByText(/still held for review/, {}, { timeout: 4000 })).toBeVisible();
    await expect(cutout.getByText('Unsaved')).toBeVisible();
  },
};

/** The trailer says how it will open before it is saved, and refuses a link that is not https. */
export const Trailer: Story = {
  args: { art: 'empty' },
  globals: desktop,
  async play({ canvasElement }) {
    const trailer = panel(within(canvasElement), 'Trailer');
    const link = trailer.getByRole('textbox', { name: 'Video link' });
    await userEvent.type(link, 'http://example.com/trailer');
    await expect(trailer.getByText('Use a link that starts with https://.')).toBeVisible();
    await expect(trailer.getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.clear(link);
    await userEvent.type(link, 'https://vimeo.com/76979871');
    await expect(trailer.getByText('Opens vimeo.com in a new tab.')).toBeVisible();
    await userEvent.clear(link);
    await userEvent.type(link, 'https://www.bilibili.com/video/BV1GJ411x7h7/');
    await expect(trailer.getByText(/Bilibili’s player on the page/)).toBeVisible();
    await userEvent.click(trailer.getByRole('button', { name: 'Save' }));
    await expect(await trailer.findByText(/Saved\. Every Zone/)).toBeVisible();
  },
};

/** The preview's reader language picks Main's title in that language and mirrors the stage for a right-to-left one. */
export const RightToLeftPreview: Story = {
  globals: desktop,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('combobox', { name: 'Reader language' }));
    await userEvent.click(await within(document.body).findByRole('option', { name: 'Arabic (right to left)' }));
    const doc = await stage(canvasElement);
    await waitFor(() => expect(doc.querySelector('.showcase-title')?.textContent).toBe('مدّ النجوم'));
    await expect(doc.querySelector('[dir="rtl"] .showcase')).toBeTruthy();
    // No Arabic logo and no neutral one: the Arabic title is drawn live.
    await expect(doc.querySelector('img.showcase-logo')).toBeNull();
  },
};

/** The phone window shows the 3:4 card with the next one peeking. */
export const PhoneWindow: Story = {
  globals: desktop,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('radio', { name: 'Phone' }));
    const doc = await stage(canvasElement);
    await waitFor(() => {
      const item = doc.querySelector('.showcase-item')!.getBoundingClientRect();
      return expect(Math.abs(item.width / item.height - 3 / 4)).toBeLessThan(0.02);
    });
  },
};
