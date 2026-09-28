import { plural } from './plural.ts';
import type { EmailCopy } from './types.ts';

const topics: Record<string, { other: string }> = {
  reply: { other: '{n} 則回覆' },
  mention: { other: '{n} 次提及' },
  'post-vote': { other: '{n} 次貼文按讚' },
  'followed-chapter': { other: '{n} 個新章節' },
  'review-helpful': { other: '{n} 次書評獲讚' },
  review: { other: '{n} 篇書評' },
  'submission-decision': { other: '{n} 項投稿決定' },
  'moderation-outcome': { other: '{n} 項處理結果' },
  'realm-role-change': { other: '{n} 次角色變更' },
  'realm-membership-change': { other: '{n} 次成員變更' },
  'realm-invitation': { other: '{n} 則社群邀請' },
  'claim-correction': { other: '{n} 項主張更正' },
  notification: { other: '{n} 則通知' },
};

const copy: EmailCopy = {
  verify: { subject: '驗證電子郵件地址', body: '請確認這個電子郵件地址用於你的 REZICS 帳戶。', action: '驗證電子郵件' },
  reset: { subject: '重設密碼', body: '為你的 REZICS 帳戶設定新密碼。這個連結將在 30 分鐘後失效。', action: '重設密碼' },
  'change-email': { subject: '確認更換電子郵件', body: '請確認更換 REZICS 電子郵件的請求。之後還需要驗證新的地址。', action: '確認更換' },
  notice: { subject: '關於你的 REZICS 帳戶的訊息', body: 'REZICS 團隊就你的帳戶傳送了以下訊息：', action: '開啟你的 REZICS 帳戶' },
  digest: { subject: '你的 REZICS 通知摘要', body: '這是你這一天的通知摘要。', action: '開啟 REZICS' },
  ignore: '如果你沒有提出這個請求，可以忽略這封郵件。',
  digestMore: '還有更多通知，可在 REZICS 中查看。',
  digestLine: (topic, count) => plural('zh-Hant', count, topics[topic] ?? topics.notification!),
};

export default copy;
