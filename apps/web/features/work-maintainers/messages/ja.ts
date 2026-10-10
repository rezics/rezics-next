// Machine-drafted; needs native review.
import { insert } from 'native-i18n';
import type { WorkMaintainerMessages } from '../messages.ts';

const messages: WorkMaintainerMessages = {
  heading: '維持管理者',
  help: 'この作品を編集できる人です。一覧にいる人は誰でも維持管理者を追加できます。取り除けるのは所有者だけです。',
  owner: '所有者',
  addLabel: '維持管理者を追加',
  addHelp: '相手のハンドル（例: @lin_mei）か、そのアドレス。',
  add: '追加',
  remove: '取り除く',
  removeNamed: insert('{{name}}を取り除く', { name: String }),
  confirmTitle: insert('{{name}}を取り除きますか？', { name: String }),
  confirmBody: insert('{{name}}はこの作品を編集できなくなります。すでに書かれた内容はそのまま残ります。', { name: String }),
  confirm: '取り除く',
  cancel: 'キャンセル',
  saved: '維持管理者の一覧を更新しました。',
  savedReplayed: 'この変更はすでに記録されています。',
  conflictTitle: 'この一覧は開いた後に変わりました',
  conflictBody: 'それ以上は書き込まれていません。最新の一覧を読み込んでください。入力した内容はこのまま残ります。',
  reload: '最新の一覧を読み込む',
  continuityTitle: 'この作品には最後の維持管理者が残ります',
  continuityBody: '編集できる人が誰かいなければなりません。',
  deniedTitle: 'この変更はできません',
  deniedBody: '維持管理者を取り除けるのは所有者だけです。追加はどの維持管理者でもできます。',
  signInTitle: '維持管理者を変えるには、もう一度ログインしてください',
  invalidTitle: '受け付けられませんでした',
  unavailableTitle: '維持管理者を変更できませんでした',
  unavailableBody: '何も変更されていません。しばらくしてからもう一度試してください。',
  loadFailed: '維持管理者を読み込めませんでした。',
  retry: '再試行',
  loading: '維持管理者を読み込んでいます',
  emptyQuery: 'ハンドルかアドレスを入力してください。',
  badTarget: 'ハンドル（例: @lin_mei）か、そのアイデンティティのアドレスを使ってください。',
  notFound: 'そのハンドルのアイデンティティはありません。',
  already: insert('{{name}}はすでにこの作品の維持管理者です。', { name: String }),
  self: 'あなたはすでにこの作品の維持管理者です。',
  mainSays: '理由',
};

export default messages;
