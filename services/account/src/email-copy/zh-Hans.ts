import { plural } from './plural.ts';
import type { EmailCopy } from './types.ts';

const topics: Record<string, { other: string }> = {
  reply: { other: '{n} 条回复' },
  mention: { other: '{n} 次提及' },
  'post-vote': { other: '{n} 次帖子获赞' },
  'followed-chapter': { other: '{n} 个新章节' },
  'review-helpful': { other: '{n} 次书评获赞' },
  review: { other: '{n} 篇书评' },
  'submission-decision': { other: '{n} 项提交决定' },
  'moderation-outcome': { other: '{n} 项处理结果' },
  'realm-role-change': { other: '{n} 次角色变更' },
  'realm-membership-change': { other: '{n} 次成员变更' },
  'realm-invitation': { other: '{n} 条社区邀请' },
  'claim-correction': { other: '{n} 项声明更正' },
  notification: { other: '{n} 条通知' },
};

const copy: EmailCopy = {
  verify: { subject: '验证邮箱地址', body: '请确认此邮箱地址用于你的 REZICS 账号。', action: '验证邮箱' },
  reset: { subject: '重置密码', body: '为你的 REZICS 账号设置新密码。此链接将在 30 分钟后失效。', action: '重置密码' },
  'change-email': { subject: '确认更换邮箱', body: '请确认更换 REZICS 邮箱的请求。之后还需要验证新邮箱。', action: '确认更换邮箱' },
  notice: { subject: '关于你的 REZICS 账号的消息', body: 'REZICS 团队就你的账号给你发送了以下消息：', action: '打开你的 REZICS 账号' },
  digest: { subject: '你的 REZICS 通知摘要', body: '这是你每天的通知摘要。', action: '打开 REZICS' },
  ignore: '如果你没有发起此请求，请忽略这封邮件。',
  digestMore: '还有更多通知，可在 REZICS 中查看。',
  digestLine: (topic, count) => plural('zh-Hans', count, topics[topic] ?? topics.notification!),
};

export default copy;
