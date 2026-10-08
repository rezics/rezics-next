import type { WikiMessages } from '../messages.ts';

export default {
  region: '閱讀位置',
  upTo: '讀到:',
  upToEverything: '正在顯示全部',
  yourProgress: '你的進度',
  startOfStory: '故事開頭',
  chosen: '你的選擇',
  showEverything: '顯示全部',
  sheetTitle: '讀到哪裡',
  sheetBody: '頁面只顯示故事截至所選位置已經揭示的內容。',
  progressOption: '你自己的進度',
  progressNote: '目前:',
  progressNoneNote: '你還沒有讀完任何一章，所以從第一章開始。',
  everythingOption: '顯示全部',
  everythingNote: '包括尚未讀到的章節中揭示的記錄。',
  moreChapters: '故事的章節比此清單更多。用「顯示全部」查看其餘部分。',
  unavailable: '目前無法選擇閱讀位置。',
  // Machine-drafted; needs native review.
  numberSeekUnavailable: '這個系列還不能用集數跳轉。請瀏覽清單，或用標題搜尋。',
  close: '關閉',
} satisfies WikiMessages;
