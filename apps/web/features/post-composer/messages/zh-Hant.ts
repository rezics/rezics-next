import type { PostMessages } from '../messages.ts';

export default {
  title: '建立貼文', intro: '在社群中開啟一場對話。', community: '社群',
  communitySearch: '尋找社群', communityChange: '更換社群', work: '作品',
  workSearch: '搜尋作品', workChange: '更換作品', titleLabel: '標題', body: '你的貼文',
  edit: '撰寫', preview: '預覽', showSpoiler: '顯示劇透',
  bodyHelp: '寫下你想討論的細節、問題或想法。', spoiler: '標記為劇透',
  spoilerHelp: '貼文會在顯示內容前提醒讀者這是劇透。', rules: '社群規則',
  noRules: '此社群尚未發布規則。',
  reviewRequired: '此社群會在發布前審核貼文，因此無法在此直接發布。',
  joinRequired: '請先加入此社群，再發布貼文。', viewCommunity: '查看社群', post: '發佈', posting: '正在發佈…',
  draftSaved: '草稿已儲存於此裝置', failed: '無法發布。草稿仍保留在此，請再試一次。',
  refused: '此社群未接受這篇貼文。請查看社群規則與設定。',
  unavailable: '無法載入此社群，請再試一次。', noCommunity: '找不到符合條件的社群',
  noWork: '找不到符合條件的作品', signIn: '登入後即可發佈貼文',
  agentNeeded: '請先選擇個人檔案，再發佈貼文。', createWork: '建立作品',
} satisfies PostMessages;
