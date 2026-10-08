// Machine-drafted; needs native review.
import { insert } from 'native-i18n';

export default {
  region: 'Deine Sperre',
  title: 'Du bist in dieser Community gesperrt',
  endedTitle: 'Diese Sperre ist abgelaufen',
  permanent: 'Diese Sperre endet nicht.',
  until: insert('Diese Sperre endet am {{date}}.', { date: String }),
  ended: insert('Diese Sperre endete am {{date}}.', { date: String }),
  recorded: insert('Gesperrt am {{date}}.', { date: String }),
  reasonLabel: 'Angegebener Grund',
  appealTitle: 'Diese Sperre anfechten',
  appealHelp: 'Du kannst einmal Einspruch einlegen. Schreib, was die Moderation noch einmal prüfen soll.',
  statementLabel: 'Deine Stellungnahme',
  statementHint: 'Höchstens 2.000 Zeichen.',
  send: 'Einspruch senden',
  statementEmpty: 'Schreib, was noch einmal geprüft werden soll.',
  statementLong: 'Höchstens 2.000 Zeichen.',
  sendFailed: 'Der Einspruch wurde nicht gesendet. Deine Stellungnahme ist noch hier.',
  receivedTitle: 'Einspruch eingegangen',
  receivedBody: 'Die Moderation hat deine Stellungnahme. Für diese Sperre gibt es keinen zweiten Einspruch.',
  statementHeading: 'Was du gesendet hast',
  upheld: insert('Die Moderation hat die Sperre am {{date}} bestätigt.', { date: String }),
  upheldUndated: 'Die Moderation hat die Sperre bestätigt.',
  lifted: insert('Deine Sperre wurde am {{date}} aufgehoben.', { date: String }),
  liftedUndated: 'Deine Sperre wurde aufgehoben.',
  sharedLabel: 'Was mitgeteilt wurde',
};
