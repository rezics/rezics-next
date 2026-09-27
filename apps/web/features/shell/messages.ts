import { insert } from 'native-i18n';

export const messages = {
  home: 'REZICS home', skipToContent: 'Skip to content',
  searchRegion: 'Site search', searchLabel: 'Search works', searchPlaceholder: 'Search works…',
  search: 'Search', searchShortcut: 'Press / to search',
  navigation: 'Main navigation', menu: 'Menu', openNavigation: 'Open navigation', close: 'Close',
  collapseNavigation: 'Collapse navigation', expandNavigation: 'Expand navigation',
  notifications: 'Notifications',
  language: 'Language', displayMode: 'Display mode',
  themeSystem: 'Match system', themeLight: 'Light', themeDark: 'Dark',
  soon: 'Soon', comingSoonTitle: insert('{{feature}} is on its way', { feature: String }),
  backHome: 'Back to home', searchWorks: 'Search works',
  notFoundTitle: 'Page not found',
  notFoundBody: 'The address may be mistyped, or the page may have moved.',
  errorTitle: 'Something went wrong',
  errorBody: 'This page could not load. Try again, or come back in a moment.',
  retry: 'Try again', errorReference: 'Reference', loading: 'Loading…',
};

export type ShellMessages = typeof messages;
