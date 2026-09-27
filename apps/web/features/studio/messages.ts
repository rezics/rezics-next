import { defineMessages } from '../../i18n/define.ts';

export const messages = defineMessages({
  en: {
    createHeading: 'Create a Work',
    createHelp: 'Start with a title. Contributions and Realm decisions can be added after creation.',
    workTitle: 'Work title', titleHint: 'Up to 200 characters.', creating: 'Creating…', createWork: 'Create Work',
    createdStatus: 'Work created', createdHeading: 'Work created.',
    createdHelp: 'The Work and its Main Version were saved. Keep these IDs for later edits.',
    createAnother: 'Create another Work',
    work: 'Work', mainVersion: 'Main Version', revision: 'Revision', sourceSequence: 'Source sequence',
    titleError: 'Enter a title of at most 200 characters.',
    denied: 'This identity is not authorized to create a Work.',
    unavailable: 'Work creation is unavailable.', noResult: 'Work creation returned no result.',
    pending: 'The Work is still being reconciled. Keep your title and try again shortly.',
  },
  'zh-Hans': {
    createHeading: '创建作品',
    createHelp: '先填写标题。创建后可以添加贡献并作出领域决定。',
    workTitle: '作品标题', titleHint: '最多 200 个字符。', creating: '正在创建…', createWork: '创建作品',
    createdStatus: '作品已创建', createdHeading: '作品已创建。',
    createdHelp: '作品及其主版本已保存。请保留这些 ID，以备后续编辑。',
    createAnother: '再创建一部作品',
    work: '作品', mainVersion: '主版本', revision: '修订', sourceSequence: '来源序列',
    titleError: '请输入不超过 200 个字符的标题。',
    denied: '此身份无权创建作品。',
    unavailable: '暂时无法创建作品。', noResult: '创建作品后未收到结果。',
    pending: '作品仍在核对中。请保留标题，稍后重试。',
  },
});

export type StudioMessages = typeof messages.en;
