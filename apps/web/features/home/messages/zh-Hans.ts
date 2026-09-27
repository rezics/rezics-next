import type { HomeMessages } from '../messages.ts';

export default {
  title: '寻找作品，追寻其意义。',
  description: '搜索已发布的作品，并在选定的视角中查看每条结果。',
  searchLabel: '搜索已发布的作品', searchPlaceholder: '标题、词句或想法…', search: '搜索',
  sections: 'REZICS 上的内容', comingSoon: '即将推出',
  discoverTitle: '发现作品', discoverBody: '按最近更新、读者评分和作品类型，浏览全局或某个领域中的作品。',
  discoverAction: '浏览作品',
  createTitle: '开始一部作品', createBody: '在创作室中创建作品，之后再添加贡献并作出领域决定。',
  createAction: '打开创作室',
  readingTitle: '继续阅读', readingBody: '书架上的作品会在这里等你，从上次停下的地方继续。',
  realmsTitle: '来自你的领域', realmsBody: '你关注的领域中的新贡献和决定。',
} satisfies Partial<HomeMessages>;
