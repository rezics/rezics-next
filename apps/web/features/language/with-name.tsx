import { LocalizedText, type LocalizedValue } from '@rezics/ui/localized-text';
import type { ReactNode } from 'react';

const SLOT = '\u0000';

/**
 * A message with one name set in place, in the name's own language and
 * direction, wherever the message puts it. Plain-text consumers use `isolate`.
 */
export function withName(message: (name: string) => string, name: LocalizedValue): ReactNode {
  const [before = '', after = ''] = message(SLOT).split(SLOT);
  return <span>{before}<LocalizedText text={name} />{after}</span>;
}
