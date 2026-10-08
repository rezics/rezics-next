import { insert } from 'native-i18n';

export const messages = {
  region: 'Your ban',
  title: 'You are banned from this community',
  endedTitle: 'This ban has ended',
  permanent: 'This ban does not end.',
  until: insert('This ban ends on {{date}}.', { date: String }),
  ended: insert('This ban ended on {{date}}.', { date: String }),
  recorded: insert('Banned on {{date}}.', { date: String }),
  reasonLabel: 'Reason given',
  appealTitle: 'Appeal this ban',
  appealHelp: 'You can send one appeal. Write what the moderators should reconsider.',
  statementLabel: 'Your statement',
  statementHint: 'Up to 2,000 characters.',
  send: 'Send appeal',
  statementEmpty: 'Write what they should reconsider.',
  statementLong: 'Use 2,000 characters or fewer.',
  sendFailed: 'The appeal was not sent. Your statement is still here.',
  receivedTitle: 'Appeal received',
  receivedBody: 'Moderators have your statement. This ban has no second appeal.',
  statementHeading: 'What you sent',
  upheldTitle: 'Ban upheld',
  upheldBody: 'Moderators kept this ban.',
  reversedTitle: 'Decision reversed',
  reversedBody: 'Moderators reversed the decision. You stay banned until a moderator lifts the ban.',
  decided: insert('Decided on {{date}}.', { date: String }),
  sharedLabel: 'What they shared',
};

export type RealmAppealMessages = typeof messages;
