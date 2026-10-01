import type { WikiMessages } from '../messages.ts';

export default {
  region: '読み進めた位置',
  upTo: 'ここまで:',
  upToEverything: 'すべて表示中',
  yourProgress: 'あなたの進行状況',
  startOfStory: '物語の始まり',
  chosen: '選んだ位置',
  change: '位置を変更',
  showEverything: 'すべて表示',
  sheetTitle: 'どこまで読むか',
  sheetBody: '選んだ位置までに物語が明かした内容だけがページに表示されます。',
  progressOption: 'あなたの進行状況',
  progressNote: '現在:',
  progressNoneNote: 'まだ読了した章がないため、最初の章から始まります。',
  everythingOption: 'すべて表示',
  everythingNote: 'まだ読んでいない章で明かされる記録も含まれます。',
  moreChapters: 'この物語の章は一覧より多くあります。残りは「すべて表示」で見られます。',
  unavailable: 'いま読み進めた位置を選べません。',
  close: '閉じる',
} satisfies WikiMessages;
