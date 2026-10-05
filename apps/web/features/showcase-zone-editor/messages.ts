import { asValue, insert, materializeData, number, plural } from 'native-i18n';
import { defineMessages, type UiLocale, withEnglish } from '../../i18n/define.ts';
import de from './messages/de.ts';
import es from './messages/es.ts';
import fr from './messages/fr.ts';
import ja from './messages/ja.ts';
import ko from './messages/ko.ts';
import zhHans from './messages/zh-Hans.ts';
import zhHant from './messages/zh-Hant.ts';

// Interface copy for the Zone showcase editor in Realm management. The art controls reuse the Work
// art editor's copy (`showcase-editor/messages.ts`), with a few lines of its own where a Zone's
// slide differs from a Work. Main's reasons for a refusal are its own text, shown after the
// sentence this catalog gives the kind of refusal. Language names come from `Intl.DisplayNames`.
const en = {
  heading: 'Showcase',
  intro: 'The slides at the top of this Zone’s home page. Choose Works or link to pages, set their order and schedule, and give a slide art of its own when the Work’s art doesn’t fit the occasion. Readers see only what you save.',
  noZoneTitle: 'This Realm has no Zone',
  noZoneBody: 'A showcase belongs to a Zone’s home page. A Realm gets one when its owners create a Zone for it.',
  externalTitle: 'This Zone’s layout comes from outside REZICS',
  externalBody: 'Its presentation is kept as an external reference, so its showcase can’t be arranged here.',

  slidesHeading: 'Slides',
  slidesHelp: 'Readers see the slides in this order. Most readers act on the first slide, so lead with the one that matters most.',
  slideCount: insert('{{count}} of {{max}} slides', { count: String, max: String }),
  slidesRecommend: 'We recommend five or fewer. The stage draws five live slides at most, so a sixth appears only while an earlier slide is outside its schedule.',
  emptyTitle: 'No slides yet',
  emptyBody: 'Until you add one, the top of the home page shows the Realm’s newest picks.',
  addWork: 'Add a Work', addLink: 'Add a link',
  addLimit: 'A showcase holds six slides. Remove one to add another.',
  addWorkHeading: 'Add a Work to the showcase',
  addWorkHelp: 'Search by title, or paste a Work’s address.',
  cancel: 'Cancel',
  slideLabel: insert('Slide {{index}}', { index: String }),
  firstSlide: 'Most readers act on this slide',
  untitledSlide: 'Untitled slide',
  linkTo: insert('Link to {{href}}', { href: String }),
  workUnavailable: 'Readers can’t see this slide: its Work isn’t available to them.',
  workLoading: 'Loading the Work…',
  listLabel: 'Slides in order',
  editSlide: insert('Edit {{slide}}', { slide: String }),
  moveUp: insert('Move {{slide}} up', { slide: String }),
  moveDown: insert('Move {{slide}} down', { slide: String }),
  dragSlide: insert('Drag {{slide}} to a new place', { slide: String }),
  removeSlide: insert('Remove {{slide}}', { slide: String }),
  moved: insert('{{slide}} is now slide {{position}} of {{count}}', { slide: String, position: String, count: String }),
  scheduleUpcoming: insert('Starts {{time}}', { time: String }),
  scheduleLiveUntil: insert('Until {{time}}', { time: String }),
  scheduleLiveSince: insert('Since {{time}}', { time: String }),
  scheduleEnded: insert('Ended {{time}}', { time: String }),
  artOwn: 'Art for this Zone', artWork: 'The Work’s art', artCover: 'Built from the cover', artNone: 'No art',
  slideNeedsAttention: 'Needs attention',

  targetHeading: 'Where the slide leads',
  targetWork: 'A Work', targetLink: 'A link',
  workField: 'Work', workChange: 'Choose another Work',
  linkField: 'Address on this site',
  linkHelp: 'A page of this site, starting with “/”, such as /r/fiction.',
  linkEmpty: 'Enter an address.',
  linkForm: 'Start with a single “/” and use no spaces, for example /r/fiction.',
  wordsHeading: 'Words',
  wordsHelp: 'Optional. A Work’s tagline and action are drawn on its slide in each reader’s language. Add a kicker, or a title that replaces the Work’s own; a link needs a title.',
  kicker: 'Kicker', kickerHelp: 'A short line above the title, such as “Game of the week”.',
  title: 'Title', titleHelp: 'Shown in place of the Work’s own title.',
  translations: 'Translations',
  translationsHelp: 'A reader whose language has no translation here sees the default text above.',
  kickerIn: insert('Kicker in {{language}}', { language: String }),
  titleIn: insert('Title in {{language}}', { language: String }),
  tooLong: insert('Use at most {{max}} characters.', { max: String }),
  scheduleHeading: 'Schedule',
  scheduleHelp: 'Leave both empty to show the slide for as long as it is in the showcase.',
  scheduleZone: insert('Times use your device’s clock: {{zone}}.', { zone: String }),
  startsAt: 'Shown from', endsAt: 'Shown until', clearTime: 'Clear',
  scheduleEmpty: 'The end must come after the start.',
  scheduleInvalid: 'This isn’t a date and time.',

  artHeading: 'Art for this Zone',
  artIntro: 'Art added here is used on this Zone’s slide only and overrides the Work’s own showcase art. Leave it empty to use the Work’s art. Keep words out of the art: the title and actions are drawn live on top.',
  sourceOwn: 'This slide uses art made for this Zone.',
  sourceWork: 'This slide uses the Work’s own showcase art. Add background art below to override it for this Zone.',
  sourceCover: 'This slide is built from the Work’s cover: the cover beside the live title, on a blurred backdrop made from it.',
  sourceNone: 'This slide has no art, so readers see its words on a plain backdrop. Add background art below.',
  noRealm: 'This Zone has no default Realm, so it can’t take campaign art yet.',
  slotAdd: 'Use for this slide', slotAdding: 'Adding…',
  slotAdded: 'Added to this slide. Save the showcase to show it to readers.',
  slotAddedReplayed: 'This image had already been added.',
  slotNotAdded: 'Not added yet', slotOnSlide: 'On this slide',
  imageUnavailable: 'This image can’t be shown right now: it may still be processing, or the Realm hides it. Replace it or remove it.',
  slotRefusalDenied: 'You can’t add campaign art to this Zone: it needs the authority to edit the Zone. Ask a Realm owner.',
  slotRefusalGone: 'This Zone can no longer be read as your identity, so nothing was added.',
  slotUploadHeld: 'This image is still held for review. Use it again later, once staff clear it.',
  slotUploadSlow: 'The image check is taking longer than usual. Use it again in a moment.',

  effectHeading: 'Title style',
  effectHelp: 'How a slide’s title is drawn when there is no logo. It applies to every slide of this Zone.',
  effectPlain: 'Plain', effectOutline: 'Outline', effectGradient: 'Gradient', effectGlow: 'Glow',
  effectSample: 'Sample', effectSampleText: 'The title of a slide',

  previewHint: 'Slides outside their schedule are shown here too. Readers see each one only within its schedule, and at most five at a time. The preview does not rotate, so the slide you are editing stays in view.',
  previewNothing: 'Add a slide to see the stage.',
  previewMasked: 'An image whose content hasn’t been labelled appears as a hidden-image icon, here and for readers.',

  unsaved: 'Unsaved changes', allSaved: 'Everything is saved',
  save: 'Save showcase', saving: 'Saving…', discard: 'Discard changes',
  pendingImages: plural({ one: insert('{{count}} image hasn’t been added to its slide yet. Add or discard it to save.'),
    other: insert('{{count}} images haven’t been added to their slides yet. Add or discard them to save.') }, { count: asValue(number()) }),
  fixProblems: 'Fix the marked fields to save.',
  needsModule: 'This Zone’s layout has no showcase area, so saving adds one at the top of its home page.',
  savedNotice: 'Saved. The Zone’s home page now shows these slides.',
  savedReplayed: 'This exact showcase had already been saved.',
  refusalSignIn: 'Your session has ended. Sign in again to save.',
  refusalDenied: 'You can’t change this Zone’s showcase: it needs the authority to edit the Zone. Ask a Realm owner.',
  refusalGone: 'This Zone can no longer be read as your identity, or is gone, so nothing was saved.',
  refusalConflict: 'The Zone changed since you opened this page. Nothing was overwritten. Reload the latest: your changes stay, and saving replaces the Zone’s slides with yours.',
  refusalInvalid: 'This showcase wasn’t accepted.',
  refusalRepeat: 'This save collides with an earlier one. Change something and save again.',
  refusalLimited: 'Too many changes for now. Try again in a moment.',
  refusalPending: 'This save is still being applied. Save again in a moment; it won’t be applied twice.',
  refusalUnavailable: 'REZICS couldn’t be reached. Nothing was changed; try again.',
  mainSays: 'Reason',
  reloadLatest: 'Reload latest',
  reloaded: plural({ one: insert('Reloaded. The Zone’s latest showcase has {{count}} slide; your slides replace them when you save.'),
    other: insert('Reloaded. The Zone’s latest showcase has {{count}} slides; your slides replace them when you save.') }, { count: asValue(number()) }),
  reloadFailed: 'The latest showcase couldn’t be read. Try again in a moment.',
};

export const englishMessages = en;
export type ZoneShowcaseEditorMessages = typeof en;

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
export type ZoneEditorCopy = ReturnType<typeof copyOf>;
