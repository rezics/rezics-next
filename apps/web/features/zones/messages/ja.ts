import { asValue, insert, number, plural } from 'native-i18n';
import type { ZoneMessages } from '../messages.ts';

export default {
  more: 'もっと見る', shuffle: '入れ替える',
  whyHere: insert('「{{title}}」がここにある理由', { title: String }),
  untitled: 'タイトル未設定の作品',
  rank: insert('第{{rank}}位', { rank: String }),
  day: '今日', week: '今週', month: '今月', completed: '完結済み',
  newChapter: insert('新着：{{chapter}}', { chapter: String }),
  heroLabel: '注目', previous: '前へ', next: '次へ',
  slide: insert('全{{count}}枚中{{index}}枚目', { index: String, count: String }),
  read: '読み始める', readWork: '作品を見る',
  dismiss: '閉じる', announcement: 'お知らせ',
  adopted: insert('「{{title}}」を追加しました', { title: String }), adoptedUnknown: '作品を追加しました',
  classified: insert('「{{title}}」を分類しました', { title: String }), classifiedUnknown: '作品を分類しました',
  classificationRejected: insert('「{{title}}」の分類を却下しました', { title: String }),
  classificationRejectedUnknown: '分類を却下しました',
  ruleChanged: 'コミュニティのルールが変更されました',
  quoteBy: insert('{{reader}}さんの言葉', { reader: String }),
  replies: plural({ one: insert('返信{{count}}件'), other: insert('返信{{count}}件') },
    { count: asValue(number()) }),
  failed: insert('{{module}}を読み込めませんでした', { module: String }), retry: '再試行',
  lookLabel: 'ページスタイル', lookZone: 'コミュニティのデザイン', lookStandard: '標準スタイル',
  lookHelp: '標準スタイルはすべてのコミュニティに適用されます。',
  lookSaveFailed: 'ページスタイルを保存できませんでした。もう一度お試しください。',
  safeModeTitle: 'このコミュニティの標準レイアウトを表示しています',
  safeModeBody: 'このページではカスタムデザインを無効にしているため、すべての内容がプラットフォーム標準のコンポーネントで表示されます。',
  showDesign: 'デザイン全体を表示',
  // The default layout's module titles.
  picks: '注目作品', genres: 'ジャンル', latest: '最新作品', newChapters: '新着エピソード',
  newlyAdded: '新着作品', recentlyCompleted: '最近完結した作品', rankings: 'ランキング',
  quotes: '読者の声', rising: '新登場・急上昇', decisions: '最近の決定',
} satisfies Partial<ZoneMessages>;
