'use client';

/**
 * The document Ark components look up their parts in and portal their layers to. Wrap a subtree
 * rendered into another document, such as a same-origin iframe used as a preview window, so that
 * carousels, dialogs and menus inside it work in that document instead of the page's.
 */
export { EnvironmentProvider } from '@ark-ui/react/environment';
