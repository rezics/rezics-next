import { insert, materializeData } from 'native-i18n';
import { defineMessages, type UiLocale, withEnglish } from '../../i18n/define.ts';
import de from './messages/de.ts';
import es from './messages/es.ts';
import fr from './messages/fr.ts';
import ja from './messages/ja.ts';
import ko from './messages/ko.ts';
import zhHans from './messages/zh-Hans.ts';
import zhHant from './messages/zh-Hant.ts';

// Interface copy for a Work's showcase art editor. Main's reasons for a refusal are its own text,
// shown after the sentence this catalog gives the kind of refusal. Language names come from
// `Intl.DisplayNames`, never from here.
const en = {
  heading: 'Showcase',
  intro: 'The art for this Work’s slide in Zone showcases. Every Zone that features the Work uses it, unless the Zone gives the slide art of its own. Keep words out of the art: the title, tagline and actions are drawn live on top, in each reader’s language.',
  unsaved: 'Unsaved', saved: 'Saved', notSet: 'Not set', willRemove: 'Removed when you save',

  backgroundsHeading: 'Backgrounds',
  landscapeTitle: 'Landscape · 16:9',
  landscapeHelp: 'Shown in every window wider than tall, and on tablets and desktops. At least 1280 × 720 pixels.',
  portraitTitle: 'Portrait · 3:4',
  portraitHelp: 'Shown on phones held upright. At least 960 × 1280 pixels.',
  landscapeMissing: 'Without landscape art, the slide is built from the Work’s cover: the cover beside the live title, on a blurred backdrop made from it.',
  portraitMissingWhole: 'No portrait art yet. Phones show the landscape art whole, on a blurred backdrop made from it. Mark a focal area in the landscape art, or add portrait art, to fill the phone card.',
  portraitMissingTooWide: 'No portrait art yet. The landscape focal area is wider than a phone card, so phones show the landscape art whole, on a blurred backdrop. Narrow the focal area, or add portrait art.',
  portraitMissingCut: 'No portrait art yet. Phones show the part of the landscape art marked “Phones”: a 3:4 cut around its focal area.',
  portraitMissingCover: 'No portrait art and no landscape art yet: phones show the slide built from the cover.',
  chooseImage: 'Choose an image', replaceImage: 'Replace image', remove: 'Remove', discard: 'Discard changes',
  save: 'Save', saving: 'Saving…',
  backgroundTypes: 'JPEG, PNG or WebP, up to 8 MB.',
  layerTypes: 'PNG or WebP with transparency, up to 8 MB.',

  frameLabel: insert('Frame, {{width}} × {{height}} pixels', { width: String, height: String }),
  frameKeys: 'Arrow keys move the frame; plus and minus change its size.',
  focalLabel: insert('Focal area, {{width}} × {{height}} pixels', { width: String, height: String }),
  focalKeys: 'Arrow keys move the focal area; with Alt held they change its size.',
  frameSize: 'Frame size',
  pixels: insert('{{width}} × {{height}} px', { width: String, height: String }),
  markFocal: 'Mark the focal area', clearFocal: 'Remove the focal area',
  focalHelp: 'The frame is what wide windows show. The focal area is the part that must stay in view when a narrower frame cuts the art.',
  phoneWindow: 'Phones',

  logosHeading: 'Logos',
  logosHelp: 'An official logo replaces the live title for readers whose title is in the logo’s language; the title remains its text for screen readers. A language-neutral logo serves every title language without a logo of its own.',
  logoNeutral: 'Language-neutral',
  logoNeutralOption: 'Language-neutral (no words)',
  logoOtherLanguage: 'Another language…',
  logoLanguage: 'Language', logoLanguageTag: 'Language tag',
  logoLanguageTagHelp: 'A BCP 47 tag, such as pt-BR or zh-Hant.',
  logoLanguageTagInvalid: 'This is not a language tag. Use one such as pt-BR or zh-Hant.',
  logoTone: 'Tone',
  toneLight: 'Light', toneLightHelp: 'For dark backdrops. The showcase draws this one.',
  toneDark: 'Dark', toneDarkHelp: 'For light backdrops. Kept for places with a light background; the showcase does not draw it.',
  logoAnchor: 'Position',
  anchorStartBottom: 'Above the title', anchorCenterTop: 'Top centre', anchorCenterMiddle: 'Centre', anchorCenterBottom: 'Bottom centre',
  addLogoHeading: 'Add a logo', chooseLogo: 'Choose a logo file',
  logoName: insert('{{language}} · {{tone}}', { language: String, tone: String }),
  logoReplaces: insert('Replaces the saved {{logo}} logo when you save.', { logo: String }),
  noLogos: 'No logos yet: every reader sees the live title.',
  coverageHeading: 'Which titles get a logo',
  coverageHelp: 'The showcase picks the logo by the language the title is shown in.',
  coverageLanguage: 'Title language', coverageShows: 'Shown',
  coverageLogo: insert('{{logo}} logo', { logo: String }),
  coverageLiveTitle: 'Live title',
  coverageDarkOnly: 'Live title: there is only a dark logo, and the showcase needs a light one',

  cutoutTitle: 'Cutout',
  cutoutHelp: 'A character or object with a transparent background, drawn over the art. It may break out of the top of the frame.',

  trailerTitle: 'Trailer',
  trailerHelp: 'A link to a video on YouTube, Bilibili or any https page. Nothing plays by itself.',
  trailerLink: 'Video link',
  trailerOpensYoutube: 'Opens in YouTube’s privacy-enhanced player on the page, loaded only when a reader asks for it.',
  trailerOpensBilibili: 'Opens in Bilibili’s player on the page, loaded only when a reader asks for it.',
  trailerOpensTab: insert('Opens {{host}} in a new tab.', { host: String }),
  trailerEmpty: 'Paste a link first.', trailerNotHttps: 'Use a link that starts with https://.',
  trailerCredentials: 'Remove the user name or password from the link.',
  trailerTooLong: 'This link is longer than 2048 characters.',
  trailerNone: 'No trailer: the slide shows no “Watch trailer” action.',
  removeTrailer: 'Remove trailer',

  fileType: 'This kind of file can’t be used here.',
  fileBytes: 'This file is larger than 8 MB.',
  filePixels: 'This image is larger than 16,384 pixels on a side or 32 megapixels in all.',
  fileUnreadable: 'This file couldn’t be read as an image.',
  fileAlpha: 'This file has no transparency (no alpha channel). Logos and cutouts are drawn over the art, so a solid background would cover it. Export it as PNG or WebP with transparency, then choose it again.',
  fileSmall: insert('This image is {{width}} × {{height}} pixels; this art needs at least {{minWidth}} × {{minHeight}}.',
    { width: String, height: String, minWidth: String, minHeight: String }),

  stageUploading: 'Uploading…',
  stageScreening: 'Checking the image. It can be used as soon as the check clears it, usually within seconds.',
  stageHeld: 'This image is held for review by REZICS staff. It can be used once they clear it; this page keeps checking while it is open.',
  stageSaving: 'Saving…',
  uploadRejected: 'Screening rejected this image, so it can’t be shown. Choose another image.',
  uploadHeld: 'This image is still held for review. Save again later to use it once staff clear it.',
  uploadSlow: 'The image check is taking longer than usual. Save again in a moment.',
  uploadLimited: insert('You have uploaded too many images for now. Try again in {{seconds}} seconds.', { seconds: String }),
  uploadFailed: 'The upload didn’t finish. Nothing was saved; try again.',
  savedNotice: 'Saved. Every Zone that features this Work now shows the change.',
  savedReplayed: 'This exact change had already been saved.',
  refusalSignIn: 'Your session has ended. Sign in again to save.',
  refusalDenied: 'You can’t change this Work’s showcase art: it needs the authority that selects the Work’s cover. Ask the Work’s maintainers.',
  refusalGone: 'This Work can no longer be read as your identity, so nothing was saved.',
  refusalConflict: 'Someone changed this since you started. Nothing was overwritten: reload to see their version, then save yours again if you still want it.',
  refusalCrop: 'The frame or the focal area doesn’t fit inside the image.',
  refusalRatio: 'The frame isn’t exactly the required shape.',
  refusalResolution: 'The framed area is smaller than the minimum size.',
  refusalAlpha: 'REZICS found no transparency (alpha channel) in this image. Export it as PNG or WebP with transparency.',
  refusalTrailer: 'This link can’t be a trailer. Use an https link without a user name or password; a YouTube or Bilibili link must name one video.',
  refusalMissing: 'Your identity can’t use this image: it may still be under review, or someone else uploaded it. Upload the file again.',
  refusalRepeat: 'This save collides with an earlier one. Change something and save again.',
  refusalLimited: 'Too many changes for now. Try again in a moment.',
  refusalInvalid: 'This wasn’t accepted.',
  refusalUnavailable: 'REZICS couldn’t be reached. Nothing was changed; try again.',
  reloadLatest: 'Reload latest', mainSays: 'Reason',

  previewHeading: 'Preview',
  previewHelp: 'The showcase stage as readers see it, with your unsaved changes. Readers see only what you save.',
  previewWindow: 'Window', previewPhone: 'Phone', previewTablet: 'Tablet', previewDesktop: 'Desktop',
  previewLanguage: 'Reader language',
  previewRtl: insert('{{language}} (right to left)', { language: String }),
  previewFrame: insert('Showcase preview: {{window}}', { window: String }),
  previewStage: 'Featured',
  previewNext: 'Next featured Work', previewAnother: 'Another featured Work',
  previewPointer: 'The list of coming slides appears beside the stage on wide screens with a mouse or trackpad.',
  previewEnlarge: 'Full size',
};

export const englishMessages = en;
export type ShowcaseEditorMessages = typeof en;

export const messages = defineMessages({
  en,
  'zh-Hant': withEnglish(en, zhHant),
  'zh-Hans': withEnglish(en, zhHans),
  ja: withEnglish(en, ja),
  ko: withEnglish(en, ko),
  de: withEnglish(en, de),
  fr: withEnglish(en, fr),
  es: withEnglish(en, es),
});

/** The interface strings of one locale, ready to call; materialize on the side that renders them. */
export const copyOf = (locale: UiLocale) => materializeData(messages[locale], { locale });
export type EditorCopy = ReturnType<typeof copyOf>;
