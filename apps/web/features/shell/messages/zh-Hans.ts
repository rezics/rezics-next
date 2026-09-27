import { insert } from 'native-i18n';
import type { ShellMessages } from '../messages.ts';

export default {
  home: 'REZICS 首页', skipToContent: '跳到主要内容',
  searchRegion: '站内搜索', searchLabel: '搜索作品', searchPlaceholder: '搜索作品…',
  search: '搜索', searchShortcut: '按 / 键开始搜索',
  navigation: '主导航', menu: '菜单', openNavigation: '打开导航', close: '关闭',
  collapseNavigation: '收起导航', expandNavigation: '展开导航',
  notifications: '通知',
  language: '语言', displayMode: '显示模式',
  themeSystem: '跟随系统', themeLight: '浅色', themeDark: '深色',
  soon: '即将推出', comingSoonTitle: insert('{{feature}}即将推出', { feature: String }),
  backHome: '返回首页', searchWorks: '搜索作品',
  notFoundTitle: '找不到页面',
  notFoundBody: '网址可能有误，或页面已经移动。',
  errorTitle: '出了点问题',
  errorBody: '此页面无法加载。请重试，或稍后再来。',
  retry: '重试', errorReference: '参考编号', loading: '正在加载…',
} satisfies Partial<ShellMessages>;
