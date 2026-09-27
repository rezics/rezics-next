import type { OnboardingMessages } from '../messages.ts';

export default {
  welcome: '欢迎来到 REZICS',
  welcomeHelp: '为个人资料选择用户名。公开名称会与用户名一起显示。',
  displayName: '显示名称',
  displayNameHelp: '此名称来自您的 REZICS 账户。',
  handle: '您的用户名',
  handleHelp: '使用 3 至 30 个英文字母、数字或下划线。用户名不区分大小写。',
  checking: '正在检查是否可用…',
  available: '此用户名可用。',
  current: '这是您当前的用户名。',
  taken: '此用户名已被使用，请换一个。',
  reserved: '此用户名不能使用，请换一个。',
  invalid: '请使用 3 至 30 个英文字母、数字或下划线。',
  checkFailed: '无法检查用户名，请重试。',
  continue: '前往首页',
  pending: '正在准备您的个人资料',
  pendingHelp: '通常只需片刻。您的登录状态已保存。',
  retry: '重试',
  failed: '暂时无法完成个人资料设置，请重试。',
  changeConflict: '此用户名已更改或不可用，请重新检查。',
  interestsLater: '您可以稍后选择想关注的话题和社区。',
} satisfies Partial<OnboardingMessages>;
