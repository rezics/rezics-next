// Display preferences live in cookies the page can write, so the server renders
// the chosen theme and navigation width on the first paint.
export const THEME_COOKIE = 'rezics_theme';
export const NAV_COOKIE = 'rezics_nav';

export const themes = ['system', 'light', 'dark'] as const;
export type Theme = (typeof themes)[number];

export function parseTheme(value: string | undefined): Theme {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/** The class on <html>. No class follows the system preference (see @rezics/ui styles.css). */
export function themeClass(theme: Theme): 'light' | 'dark' | undefined {
  return theme === 'system' ? undefined : theme;
}

export function parseNavCollapsed(value: string | undefined): boolean {
  return value === 'collapsed';
}

/** A year-long, site-wide cookie. It holds no secret, so it is not HttpOnly. */
export function preferenceCookie(name: string, value: string, secure: boolean): string {
  return `${name}=${value}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? '; Secure' : ''}`;
}
