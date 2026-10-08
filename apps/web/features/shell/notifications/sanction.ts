import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../../i18n/define.ts';
import { messages } from './messages.ts';

export interface SanctionFacts {
  action: 'ban' | 'unban';
  realm: string;
  reason: string;
  until: string | null;
  permanent: boolean;
}

/** The sentence a banned member reads. It names the Realm, the action, the
 * recorded reason and the end, and it never takes a moderator. */
export function sanctionSentence(locale: UiLocale, facts: SanctionFacts): string {
  const copy = materializeData(messages[locale], { locale });
  const realm = facts.realm || copy.thisRealm;
  const reason = facts.reason;
  if (facts.action === 'unban') return copy.unbanned({ realm, reason });
  if (facts.permanent || !facts.until) return copy.bannedPermanent({ realm, reason });
  const end = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })
    .format(new Date(facts.until));
  return copy.bannedUntil({ realm, end, reason });
}
