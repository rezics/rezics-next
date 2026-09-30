import type { PostMessages } from '../messages.ts';

export default {
  title: '投稿を作成', intro: 'コミュニティで会話を始めましょう。', community: 'コミュニティ',
  communitySearch: 'コミュニティを探す', communityChange: 'コミュニティを変更', work: '作品',
  workSearch: '作品を検索', workChange: '作品を変更', titleLabel: 'タイトル', body: '投稿内容',
  postLanguage: '投稿の言語', edit: '書く', preview: 'プレビュー', showSpoiler: 'ネタバレを表示',
  bodyHelp: '話し合いたい詳細、質問、アイデアを書いてください。', spoiler: 'ネタバレとしてマーク',
  spoilerHelp: '本文を表示する前に、ネタバレが含まれることを読者に知らせます。', rules: 'コミュニティのルール',
  noRules: 'このコミュニティではルールがまだ公開されていません。',
  reviewRequired: 'このコミュニティでは公開前に投稿が審査されます。ここから直接投稿することはできません。',
  joinRequired: '投稿する前にこのコミュニティに参加してください。', viewCommunity: 'コミュニティを見る',
  post: '投稿', posting: '投稿中…', draftSaved: '下書きをこの端末に保存しました',
  failed: '公開できませんでした。下書きは残っています。もう一度お試しください。',
  refused: 'このコミュニティで投稿が受け入れられませんでした。ルールと設定を確認してください。',
  unavailable: 'このコミュニティを読み込めませんでした。もう一度お試しください。',
  noCommunity: '一致するコミュニティはありません', noWork: '一致する作品はありません',
  signIn: '投稿するにはログインしてください', agentNeeded: '投稿する前に個人プロフィールを選んでください。',
  createWork: '作品を作成',
} satisfies PostMessages;
