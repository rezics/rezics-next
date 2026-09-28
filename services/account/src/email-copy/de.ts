import { plural } from './plural.ts';
import type { EmailCopy } from './types.ts';

const topics: Record<string, { one?: string; other: string }> = {
  reply: { one: '{n} Antwort', other: '{n} Antworten' },
  mention: { one: '{n} Erwähnung', other: '{n} Erwähnungen' },
  'post-vote': { one: '{n} Stimme für Ihre Beiträge', other: '{n} Stimmen für Ihre Beiträge' },
  'followed-chapter': { one: '{n} neues Kapitel', other: '{n} neue Kapitel' },
  'review-helpful': { one: '{n} hilfreiche Stimme zu Ihren Rezensionen', other: '{n} hilfreiche Stimmen zu Ihren Rezensionen' },
  review: { one: '{n} Rezension', other: '{n} Rezensionen' },
  'submission-decision': { one: '{n} Entscheidung zu einer Einreichung', other: '{n} Entscheidungen zu Einreichungen' },
  'moderation-outcome': { one: '{n} Moderationsergebnis', other: '{n} Moderationsergebnisse' },
  'realm-role-change': { one: '{n} Rollenänderung', other: '{n} Rollenänderungen' },
  'realm-membership-change': { one: '{n} Mitgliedschaftsänderung', other: '{n} Mitgliedschaftsänderungen' },
  'realm-invitation': { one: '{n} Community-Einladung', other: '{n} Community-Einladungen' },
  'claim-correction': { one: '{n} Anspruchskorrektur', other: '{n} Anspruchskorrekturen' },
  notification: { one: '{n} Benachrichtigung', other: '{n} Benachrichtigungen' },
};

const copy: EmailCopy = {
  verify: { subject: 'E-Mail-Adresse bestätigen', body: 'Bestätigen Sie diese E-Mail-Adresse für Ihr REZICS-Konto.', action: 'E-Mail bestätigen' },
  reset: { subject: 'Passwort zurücksetzen', body: 'Legen Sie ein neues Passwort für Ihr REZICS-Konto fest. Der Link läuft in 30 Minuten ab.', action: 'Passwort zurücksetzen' },
  'change-email': { subject: 'E-Mail-Änderung bestätigen', body: 'Bestätigen Sie die Änderung Ihrer REZICS-E-Mail-Adresse. Anschließend müssen Sie die neue Adresse bestätigen.', action: 'Änderung bestätigen' },
  notice: { subject: 'Eine Nachricht zu Ihrem REZICS-Konto', body: 'Das REZICS-Team hat Ihnen diese Nachricht zu Ihrem Konto geschickt:', action: 'REZICS-Konto öffnen' },
  digest: { subject: 'Ihr REZICS-Benachrichtigungsüberblick', body: 'Das ist heute bei Ihnen passiert.', action: 'REZICS öffnen' },
  ignore: 'Wenn Sie das nicht angefordert haben, können Sie diese E-Mail ignorieren.',
  digestMore: 'Weitere Benachrichtigungen warten in REZICS.',
  digestLine: (topic, count) => plural('de', count, topics[topic] ?? topics.notification!),
};

export default copy;
