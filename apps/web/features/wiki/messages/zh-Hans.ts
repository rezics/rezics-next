import type { WikiMessages } from '../messages.ts';

export default {
  region: '阅读位置',
  upTo: '读到:',
  upToEverything: '正在显示全部',
  yourProgress: '你的进度',
  startOfStory: '故事开头',
  chosen: '你的选择',
  showEverything: '显示全部',
  sheetTitle: '读到哪里',
  sheetBody: '页面只显示故事截至所选位置已经揭示的内容。',
  progressOption: '你自己的进度',
  progressNote: '当前:',
  progressNoneNote: '你还没有读完任何一章，所以从第一章开始。',
  everythingOption: '显示全部',
  everythingNote: '包括尚未读到的章节中揭示的记录。',
  moreChapters: '故事的章节比此列表更多。用“显示全部”查看其余部分。',
  unavailable: '暂时无法选择阅读位置。',
  close: '关闭',
} satisfies WikiMessages;
