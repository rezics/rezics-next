// Machine-drafted; needs native review.
import { insert } from 'native-i18n';

export default {
  region: 'あなたのBAN',
  title: 'このコミュニティでBANされています',
  endedTitle: 'このBANは終了しています',
  permanent: 'このBANに終了日はありません。',
  until: insert('このBANは {{date}} に終了します。', { date: String }),
  ended: insert('このBANは {{date}} に終了しました。', { date: String }),
  recorded: insert('{{date}} にBANされました。', { date: String }),
  reasonLabel: '記録された理由',
  appealTitle: 'このBANに異議を申し立てる',
  appealHelp: '異議申し立ては1回だけです。再検討してほしい点を書いてください。',
  statementLabel: 'あなたの申し立て',
  statementHint: '2,000文字まで。',
  send: '異議を申し立てる',
  statementEmpty: '再検討してほしい点を書いてください。',
  statementLong: '2,000文字以内にしてください。',
  sendFailed: '申し立てを送れませんでした。書いた内容はそのまま残っています。',
  receivedTitle: '申し立てを受け付けました',
  receivedBody: 'モデレーターが申し立てを受け取りました。このBANに二度目の申し立てはできません。',
  statementHeading: '送った内容',
  upheld: insert('モデレーターは {{date}} にBANを維持しました。', { date: String }),
  upheldUndated: 'モデレーターはBANを維持しました。',
  lifted: insert('BANは {{date}} に解除されました。', { date: String }),
  liftedUndated: 'BANは解除されました。',
  sharedLabel: '共有された説明',
};
