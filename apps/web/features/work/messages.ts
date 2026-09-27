import { insert } from 'native-i18n';
import { defineMessages } from '../../i18n/define.ts';

export const messages = defineMessages({
  en: {
    unavailableTitle: 'This revision is unavailable',
    unavailable: 'Your access or the source service may have changed. Try again later.',
    notFoundTitle: 'Revision not found',
    notFoundBody: 'No Work revision has this ID. It may have been mistyped.',
    searchWorks: 'Search works', loading: 'Loading the revision…',
    exactRevision: 'Exact revision', perspective: 'Perspective', globalPerspective: 'Global perspective',
    perspectiveHelp: 'This exact revision follows the Main Version record.',
    views: 'Revision views', mainVersion: 'Main Version', selectedVersion: 'Selected version',
    metadata: insert('This exact metadata revision is retained as {{revision}}.', { revision: String }),
    revisionDetails: 'Revision details', work: 'Work', operation: 'Operation',
    language: 'Language', sequence: 'Sequence',
  },
  'zh-CN': {
    unavailableTitle: '无法查看此修订',
    unavailable: '您的访问权限或来源服务可能已发生变化。请稍后重试。',
    notFoundTitle: '找不到此修订',
    notFoundBody: '没有与此 ID 对应的作品修订，ID 可能有误。',
    searchWorks: '搜索作品', loading: '正在加载修订…',
    exactRevision: '精确修订', perspective: '视角', globalPerspective: '全局视角',
    perspectiveHelp: '此精确修订对应主版本记录。',
    views: '修订视图', mainVersion: '主版本', selectedVersion: '所选版本',
    metadata: insert('此元数据修订的标识为 {{revision}}。', { revision: String }),
    revisionDetails: '修订详情', work: '作品', operation: '操作',
    language: '语言', sequence: '序列',
  },
});

export type WorkMessages = typeof messages.en;
