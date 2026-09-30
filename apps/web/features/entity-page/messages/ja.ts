import { insert } from 'native-i18n';
import type { EntityPageMessages } from '../messages.ts';

export default {
  pageUnavailableTitle: '現在このページを表示できません',
  pageUnavailableBody: 'REZICS はこの記録を読み込めませんでした。しばらくしてからもう一度お試しください。',
  notFoundTitle: 'ここには何もありません',
  notFoundBody: 'このアドレスのリソースがないか、あなたには表示されません。',
  restricted: '非公開', restrictedHelp: 'アクセスを許可された人だけが見られます。',

  sections: 'セクション',
  statements: 'ステートメント', statementsUnavailable: 'ステートメントを読み込めませんでした。',
  noStatements: 'ステートメントはまだありません', noStatementsBody: '承認された内容はまだありません。',
  statementsList: 'ステートメント',
  valueSome: '不明な値', valueNone: '値なし',
  relations: '関係', relationsUnavailable: '関係を読み込めませんでした。',
  noRelations: '関係はまだありません', noRelationsBody: 'これに関連するものはまだありません。',
  relationsSignIn: 'ログインすると、関連するものを確認できます。',
  relationsIdentity: 'アイデンティティを選ぶと、関連するものを確認できます。',
  discussion: 'ディスカッション',
  startDiscussion: insert('この{{subject}}について話す', { subject: String }),
  ratingsFor: insert('この{{subject}}の評価', { subject: String }),
  reviewsFor: insert('この{{subject}}のレビュー', { subject: String }),
  ratingsReadOnly: 'これへの評価とレビューはまだ受け付けていません。',
  noRatings: '評価はまだありません。',
  unavailable: '利用できません', unnamed: '名称なし', search: '検索',
} satisfies EntityPageMessages;
