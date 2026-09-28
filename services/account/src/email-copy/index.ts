import type { AccountLocale } from '../email.ts';
import de from './de.ts';
import en from './en.ts';
import es from './es.ts';
import fr from './fr.ts';
import ja from './ja.ts';
import ko from './ko.ts';
import type { EmailCopy } from './types.ts';
import zhHans from './zh-Hans.ts';
import zhHant from './zh-Hant.ts';

export type { EmailCopy, PurposeCopy } from './types.ts';

export const emailCopy = { en, 'zh-Hant': zhHant, 'zh-Hans': zhHans, ja, ko, de, fr, es } as const satisfies Record<AccountLocale, EmailCopy>;

export function formatDigest(locale: AccountLocale, counts: readonly { topic: string; count: number }[], more: boolean): string {
  const copy = emailCopy[locale];
  const lines = counts.map(item => copy.digestLine(item.topic, item.count));
  return more ? `${lines.join('\n')}\n${copy.digestMore}` : lines.join('\n');
}
