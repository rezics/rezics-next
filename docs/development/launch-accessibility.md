# Launch journey accessibility and phones

The launch journeys listed in
[`launch-journeys.ts`](../../scripts/qa/cases/launch-journeys.ts) are held to
WCAG 2.2 A and AA, keyboard-only use, a visible and unobscured focus indicator,
reduced motion and reflow at 200% and 400% zoom, in light and dark, at a phone
and a desktop width, in a Latin and a CJK locale. The matrix is code
([`g-743-matrix.ts`](../../apps/web/tests/g-743-matrix.ts)); each journey's file
is `apps/web/tests/g-743-<journey>.e2e.ts`, and
[`g-743-journeys.test.ts`](../../apps/web/tests/g-743-journeys.test.ts) fails when
a journey lacks a part of it. This page keeps what code cannot: how to run the
engines, and what a person does on a physical phone.

## Running

One journey file per QA run: `task goal -- test apps/web/tests/g-743-hub.e2e.ts`
(`task test --` outside a Goal). The default project is Desktop Chrome, as for
every other e2e file. The phone projects are opt-in, because the journeys alone
take them and the browser budget counts files, not projects:

```sh
REZICS_E2E_PROJECTS=chromium-mobile,webkit-mobile task test -- apps/web/tests/g-743-hub.e2e.ts
REZICS_E2E_PROJECTS=all task test -- apps/web/tests/g-743-hub.e2e.ts   # desktop too
```

`chromium-mobile` is Pixel 7 emulation on Chromium; `webkit-mobile` is iPhone
15 emulation on Playwright's WebKit. WebKit is built for Ubuntu and is not
installed by default. On Fedora it also lacks `libicu74` and `libjpeg-turbo8`,
which can be unpacked from their Ubuntu packages into the browser's own `sys/lib`
without root:

```sh
export PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers   # or any directory you own
node_modules/.bin/playwright install webkit        # downloads; its dependency check then fails on Fedora
# Unpack libicu74 and libjpeg-turbo8 (Ubuntu 24.04 .deb files) and copy their usr/lib/x86_64-linux-gnu/* into
# $PLAYWRIGHT_BROWSERS_PATH/webkit-<n>/minibrowser-wpe/sys/lib/, then link the Chromium directories of
# ~/.cache/ms-playwright into $PLAYWRIGHT_BROWSERS_PATH for the Chromium project.
```

Playwright's WebKit here is the WPE port: it checks layout, forms, focus and
touch emulation in WebKit's engine, not Safari's own behaviour. VoiceOver, the
iOS keyboard and Safari's own quirks need the physical iPhone.

CJK IME composition is driven in Chromium through the DevTools protocol
(`composeCjk`); WebKit and the phones have no equivalent, so they are checked by
hand below.

## Home, Realm and shell walk

[`launch-phone-keyboard.e2e.ts`](../../apps/web/tests/launch-phone-keyboard.e2e.ts)
walks Home, Discover, a Realm's front page, discussions, About and a thread, and
the shell's drawer, account sheet and menus, as Pixel 7 touch at 390 px and as a
keyboard at 1280 px, signed out and signed in, in English and Japanese. It fails on
sideways scroll, clipped text, controls under 24 px, sticky bars under the header,
Tab stops without a ring or hidden, lost or trapped focus, and dialogs that do not
take, keep or return focus. Its eight tests run about six minutes, over the default
300 s Playwright budget: run it with `REZICS_E2E_PLAYWRIGHT_BUDGET_MS=900000`.
Joining and the Zone's own pages need a Realm that offers joining and an installed
Zone, which this stack's seeds cannot write while their platform groups are closed;
the walk adds the Zone pages when an official Zone exists on the stack.

## Physical devices

The maintainer runs these on one iPhone (Safari, VoiceOver) and one Android phone
(Chrome, TalkBack) against the local stack over the network (or the maintainer's
BrowserOS remote debugging). Record the device, OS version and browser version,
and attach a screenshot or screen recording for each line.

1. Open each journey in
   [`launch-journeys.ts`](../../scripts/qa/cases/launch-journeys.ts) at phone
   width, in light and dark, in English and Japanese. Look for text that is cut
   off or overlaps, controls under the thumb that are smaller than a fingertip,
   and a sticky bar hiding the focused field when the keyboard opens.
2. Turn on the system's reduced-motion setting and open the navigation sheet and
   the Work page's "On this page" menu: they must open without animating.
3. Zoom the page to 200% and 400% (Safari's text size and page zoom, Chrome's
   "Force enable zoom" and font size): nothing scrolls sideways.
4. In the proposal form and the review composer, write with the Japanese, Chinese
   and Korean keyboards (`imeOnDevice` in the registry): confirm a candidate with
   the keyboard's own Return and check that nothing is sent until Send is pressed.
5. One screen-reader pass per phone, on the journey the registry assigns
   (`physicalDevices`): VoiceOver on the Work hub, TalkBack on the report form.
   Note anything unlabeled, announced twice or out of order.

A finding is a line in the handoff or the task that owns the screen, with its
severity (blocks a journey, degrades it, cosmetic) and a failing test in
`g-743*` where one can express it.
