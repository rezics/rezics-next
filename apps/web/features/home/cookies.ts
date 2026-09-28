// Home's display choices, kept in cookies the page writes, so the server
// renders the same page on the next visit (see shell/preferences.ts).

/** Set when a new person puts off the setup invitation; Home then offers it as a slim line.
 * The cookie keeps the name it had when the invitation was an interest picker. */
export const PICKER_COOKIE = 'rezics_home_picker';
/** Set when a signed-out visitor dismisses the join card. */
export const WELCOME_COOKIE = 'rezics_home_welcome';
