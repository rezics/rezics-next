import { defineMessages } from '../../i18n/define.ts';

export const messages = defineMessages({
  en: {
    title: 'Find a work. Follow its meaning.',
    description: 'Search published works and view each result in its selected context.',
    searchLabel: 'Search published works', searchPlaceholder: 'Title, phrase or idea…', search: 'Search',
    sections: 'On REZICS', comingSoon: 'Coming soon',
    discoverTitle: 'Discover works', discoverBody: 'Search published works and read each in its selected context.',
    discoverAction: 'Search works',
    createTitle: 'Start a Work', createBody: 'Create a Work in Studio. Contributions and Realm decisions follow.',
    createAction: 'Open Studio',
    readingTitle: 'Continue reading', readingBody: 'The works on your shelves will wait here, where you left off.',
    realmsTitle: 'From your Realms', realmsBody: 'New contributions and decisions from the Realms you follow.',
  },
  'zh-CN': {
    title: '寻找作品，追寻其意义。',
    description: '搜索已发布的作品，并在选定的视角中查看每条结果。',
    searchLabel: '搜索已发布的作品', searchPlaceholder: '标题、词句或想法…', search: '搜索',
    sections: 'REZICS 上的内容', comingSoon: '即将推出',
    discoverTitle: '发现作品', discoverBody: '搜索已发布的作品，并在选定的视角中阅读。',
    discoverAction: '搜索作品',
    createTitle: '开始一部作品', createBody: '在创作室中创建作品，之后再添加贡献并作出领域决定。',
    createAction: '打开创作室',
    readingTitle: '继续阅读', readingBody: '书架上的作品会在这里等你，从上次停下的地方继续。',
    realmsTitle: '来自你的领域', realmsBody: '你关注的领域中的新贡献和决定。',
  },
});

export type HomeMessages = typeof messages.en;
