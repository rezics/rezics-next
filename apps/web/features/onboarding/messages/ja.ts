import type { OnboardingMessages } from '../messages.ts';

export default {
  welcome: 'REZICS へようこそ',
  welcomeHelp: 'プロフィールのユーザー名を設定してください。公開名と一緒に表示されます。',
  displayName: '表示名',
  displayNameHelp: 'この名前は REZICS アカウントから引き継がれています。',
  handle: 'ユーザー名',
  handleHelp: '半角英字、数字、アンダースコアを使って3〜30文字で設定してください。大文字と小文字は区別されません。',
  checking: '使用できるか確認中…',
  available: 'このユーザー名は使用できます。',
  current: '現在のユーザー名です。',
  taken: 'このユーザー名はすでに使われています。別の名前をお試しください。',
  reserved: 'このユーザー名は使用できません。別の名前をお試しください。',
  invalid: '半角英字、数字、アンダースコアを使って3〜30文字で設定してください。',
  checkFailed: 'ユーザー名を確認できませんでした。もう一度お試しください。',
  continue: 'ホームへ進む',
  pending: 'プロフィールを準備しています',
  pendingHelp: '通常はすぐに完了します。ログイン状態は保存されています。',
  retry: 'もう一度試す',
  failed: 'プロフィールを設定できませんでした。もう一度お試しください。',
  changeConflict: 'ユーザー名が変更されたか、利用できなくなりました。もう一度確認してください。',
  interestsLater: 'フォローするトピックやコミュニティは後から選べます。',
} satisfies Partial<OnboardingMessages>;
