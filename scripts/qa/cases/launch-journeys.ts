// The launch journeys that must be accessible and usable on a real phone (G-743), and where each one is tested.
// `apps/web/tests/g-743-journeys.test.ts` fails when a journey lacks a part of the matrix: a screen check (axe in
// light and dark at a phone and a desktop width, reflow at 200% and 400%), keyboard-only use with visible focus,
// reduced motion, a Latin and a CJK locale, and CJK IME input where the journey has a text field a person writes
// in. `apps/web/tests/g-743-matrix.ts` is the matrix; the engines (Desktop Chrome, Chromium with Android emulation,
// WebKit with iPhone emulation) are the projects of `apps/web/playwright.config.ts`.

export interface LaunchJourney {
  id: string;
  title: string;
  /** The Playwright file that walks it. */
  spec: string;
  /** The test that holds the Latin-locale run: the screens through the matrix, the keyboard-only pass under reduced motion. */
  latin: string;
  /** The test that holds the CJK-locale run of the same screens through the matrix. */
  cjk: string;
  /** The test whose text fields are written with CJK input-method composition, when the journey has one a person writes in. */
  ime?: string;
  /** The journey the reader meets signed out, which the physical-device checklist runs without signing in. */
  signedOut: boolean;
}

export const launchJourneys: readonly LaunchJourney[] = [
  {
    id: 'work-hub',
    title: 'The LN/VN Work hub and edition choice',
    spec: 'apps/web/tests/g-743-hub.e2e.ts',
    latin: 'work-hub: a reader chooses an edition with the keyboard alone, under reduced motion, in the Latin locale',
    cjk: 'work-hub: the hub and its edition choice in the CJK locale',
    signedOut: false,
  },
  {
    id: 'library-import-progress-export',
    title: 'Library import, progress on two devices and export',
    spec: 'apps/web/tests/g-743-library.e2e.ts',
    latin: 'library-import-progress-export: import, progress on two devices and the download, by keyboard, in the Latin locale',
    cjk: 'library-import-progress-export: the Library page and its import and download in the CJK locale',
    signedOut: false,
  },
  {
    id: 'franchise-wiki',
    title: 'The franchise wiki Zone within the spoiler position',
    spec: 'apps/web/tests/g-743-wiki.e2e.ts',
    latin: 'franchise-wiki: the spoiler position is set by keyboard alone under reduced motion, in the Latin locale',
    cjk: 'franchise-wiki: the Zone inside the spoiler position in the CJK locale',
    signedOut: true,
  },
  {
    id: 'propose-review-inbox',
    title: 'Propose, review and inbox',
    spec: 'apps/web/tests/g-743-contribute.e2e.ts',
    latin: 'propose-review-inbox: a contributor proposes and finds the answer in the inbox, by keyboard, in the Latin locale',
    cjk: 'propose-review-inbox: the proposal, the review and the inbox in the CJK locale',
    // The proposal form's synopsis; the review composer's message has its own test.
    ime: 'propose-review-inbox: a steward writes a review in the composer, by keyboard, with CJK input',
    signedOut: false,
  },
  {
    id: 'sign-up-with-policies',
    title: 'Sign-up with policy acceptance',
    spec: 'apps/web/tests/g-743-signup.e2e.ts',
    latin: 'sign-up-with-policies: the form is filled by keyboard alone under reduced motion, and the refusal names the policies',
    cjk: 'sign-up-with-policies: the form in the CJK locale, the name composed with an input method',
    ime: 'sign-up-with-policies: the form in the CJK locale, the name composed with an input method',
    signedOut: true,
  },
  {
    id: 'report-without-account',
    title: 'Report without an account',
    spec: 'apps/web/tests/g-743-report.e2e.ts',
    latin: 'report-without-account: a visitor files a report by keyboard alone under reduced motion, in the Latin locale',
    cjk: 'report-without-account: the same report in the CJK locale, the statement composed with an input method',
    ime: 'report-without-account: the same report in the CJK locale, the statement composed with an input method',
    signedOut: true,
  },
];

/** The engine projects every journey runs in (`REZICS_E2E_PROJECTS`, see `apps/web/playwright.config.ts`). */
export const journeyProjects = ['desktop-chrome', 'chromium-mobile', 'webkit-mobile'] as const;

/** What a person does on a physical phone, for each journey that has an IME field: CJK composition in that field. */
export const imeOnDevice: Readonly<Record<string, string>> = {
  'propose-review-inbox': 'In the proposal form, write the synopsis with the Japanese, Chinese and Korean keyboards; in the review composer, write the message the same way. Confirm a candidate with the keyboard’s own Return key and check that nothing is sent until Send is pressed.',
};

/** The physical-device and screen-reader checks the maintainer runs, kept in `docs/development/launch-accessibility.md`. */
export const physicalDevices = [
  { device: 'iPhone', browser: 'Safari', screenReader: 'VoiceOver', screenReaderJourney: 'work-hub' },
  { device: 'Android phone', browser: 'Chrome', screenReader: 'TalkBack', screenReaderJourney: 'report-without-account' },
] as const;
