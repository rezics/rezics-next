import { defineMessages } from '../../i18n/define.ts';

export const messages = defineMessages({
  en: {
    title: 'Profile settings',
    description: 'Your public profile is how people recognize you on REZICS.',
    actingAs: 'Editing',
    displayName: 'Display name',
    avatar: 'Avatar',
    accountInfo: 'This public name started with your Account name. Editing your public name and avatar is coming later.',
    otherInfo: 'Editing this Agent’s name and avatar is coming later.',
    handleTitle: 'Handle',
    handleHelp: 'You can change your handle once every 30 days. Your old profile link redirects to the new one for 90 days.',
    save: 'Change handle',
    saved: 'Your handle was changed.',
    cooldown: 'You can change your handle again 30 days after your last change.',
    conflict: 'The handle changed or became unavailable. Check it again.',
    denied: 'You can no longer change this Agent’s handle. Choose another profile.',
    failed: 'Could not change the handle. Try again.',
    choose: 'Choose a profile',
  },
  'zh-Hans': {
    title: '个人资料设置',
    description: '公开资料帮助其他人在 REZICS 上认出您。',
    actingAs: '正在编辑',
    displayName: '显示名称',
    avatar: '头像',
    accountInfo: '此公开名称最初来自您的账户名称。稍后才能修改公开名称和头像。',
    otherInfo: '稍后才能修改此身份的名称和头像。',
    handleTitle: '用户名',
    handleHelp: '每 30 天可以修改一次用户名。旧资料链接会在 90 天内跳转到新链接。',
    save: '修改用户名',
    saved: '用户名已修改。',
    cooldown: '上次修改用户名后，需等待 30 天才能再次修改。',
    conflict: '用户名已更改或不可用，请重新检查。',
    denied: '您已不能修改此身份的用户名，请选择其他身份。',
    failed: '无法修改用户名，请重试。',
    choose: '选择身份',
  },
});

export type SettingsMessages = typeof messages.en;
