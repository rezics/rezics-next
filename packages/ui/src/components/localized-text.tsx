import type React from 'react';

/** Text from content with the language and base direction Main recorded for it. */
export interface LocalizedValue {
  value: string;
  /** A BCP 47 tag; empty or `und` when nothing recorded the language. */
  language: string;
  direction: 'ltr' | 'rtl';
}

/**
 * Content text in its own language and direction. `bdi` (the default) isolates a
 * name embedded in an interface sentence, so its direction never reorders the
 * words around it; `span` is for text that stands alone as a block. A language
 * nobody recorded renders `lang=""` (unknown), never the interface's language:
 * leaving `lang` out would make the text inherit it.
 * https://www.w3.org/International/questions/qa-bidi-unicode-controls
 */
export function LocalizedText({ text, as: Tag = 'bdi', className }: {
  text: LocalizedValue; as?: 'bdi' | 'span'; className?: string;
}): React.ReactElement {
  return <Tag lang={text.language} dir={text.direction} className={className}>{text.value}</Tag>;
}
