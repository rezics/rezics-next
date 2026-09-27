import { insert } from 'native-i18n';
import { defineMessages } from '../../i18n/define.ts';

export const messages = defineMessages({
  en: {
    home: 'REZICS home', skipToContent: 'Skip to content',
    searchRegion: 'Site search', searchLabel: 'Search works', searchPlaceholder: 'Search works…',
    search: 'Search', searchShortcut: 'Press / to search',
    navigation: 'Main navigation', menu: 'Menu', openNavigation: 'Open navigation', close: 'Close',
    collapseNavigation: 'Collapse navigation', expandNavigation: 'Expand navigation',
    notifications: 'Notifications', signIn: 'Sign in', accountMenu: 'Account menu',
    signedIn: 'Signed in', actingAs: 'Acting as', noAgent: 'No acting identity chosen',
    identity: 'Identity', switchIdentity: 'Switch identity', studio: 'Studio',
    preferences: 'Preferences', language: 'Interface language', theme: 'Theme',
    themeSystem: 'Match system', themeLight: 'Light', themeDark: 'Dark',
    soon: 'Soon', comingSoonTitle: insert('{{feature}} is on its way', { feature: String }),
    backHome: 'Back to home', searchWorks: 'Search works',
    notFoundTitle: 'Page not found',
    notFoundBody: 'The address may be mistyped, or the page may have moved.',
    errorTitle: 'Something went wrong',
    errorBody: 'This page could not load. Try again, or come back in a moment.',
    retry: 'Try again', errorReference: 'Reference', loading: 'Loading…',
  },
  'zh-CN': {
    home: 'REZICS 首页', skipToContent: '跳到主要内容',
    searchRegion: '站内搜索', searchLabel: '搜索作品', searchPlaceholder: '搜索作品…',
    search: '搜索', searchShortcut: '按 / 键开始搜索',
    navigation: '主导航', menu: '菜单', openNavigation: '打开导航', close: '关闭',
    collapseNavigation: '收起导航', expandNavigation: '展开导航',
    notifications: '通知', signIn: '登录', accountMenu: '账户菜单',
    signedIn: '已登录', actingAs: '当前身份', noAgent: '尚未选择操作身份',
    identity: '身份', switchIdentity: '切换身份', studio: '创作室',
    preferences: '偏好设置', language: '界面语言', theme: '主题',
    themeSystem: '跟随系统', themeLight: '浅色', themeDark: '深色',
    soon: '即将推出', comingSoonTitle: insert('{{feature}}即将推出', { feature: String }),
    backHome: '返回首页', searchWorks: '搜索作品',
    notFoundTitle: '找不到页面',
    notFoundBody: '网址可能有误，或页面已经移动。',
    errorTitle: '出了点问题',
    errorBody: '此页面无法加载。请重试，或稍后再来。',
    retry: '重试', errorReference: '参考编号', loading: '正在加载…',
  },
});

export type ShellMessages = typeof messages.en;
