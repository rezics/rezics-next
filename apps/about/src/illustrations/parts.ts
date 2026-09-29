import type { IllustrationCopy } from '../i18n/messages/illustrations.ts';

/** What every illustration and vignette takes: the interface words, which sample content never uses. */
export type Words = { words: IllustrationCopy };

/** One line of a small list inside a vignette or plate. */
export const row =
  'flex items-center justify-between gap-3 rounded-xl border border-border bg-background px-3 py-2 text-sm';

/** A vignette: a small picture keyed by the showcase tile it sits in. */
export type Picture = (props: Words) => React.JSX.Element;
