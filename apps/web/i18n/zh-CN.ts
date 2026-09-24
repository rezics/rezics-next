export const shell = {
  home: 'REZICS 首页', searchPlaceholder: '搜索作品…', searchLabel: '搜索作品',
  search: '搜索', navigation: '主导航', studio: '创作室', identity: '身份',
  signIn: '登录', language: '界面语言', english: 'English', chinese: '简体中文',
};

export const home = {
  title: '寻找作品，追寻其意义。',
  description: '搜索已发布的作品，并在选定的视角中查看每条结果。',
  explore: '探索作品 →',
};

export const search = {
  title: '搜索作品', emptyPhrase: '请在上方输入搜索内容', perspectiveLabel: '选择查看结果的视角',
  globalPerspective: '全局视角', realmPerspective: '领域视角', realmId: '领域 ID',
  perspectiveHelp: '视角决定如何选取作品。',
  filters: '搜索筛选', language: '作品语言', anyLanguage: '不限语言',
  english: '英语', spanish: '西班牙语', japanese: '日语',
  languageHelp: '按所选语言搜索已发布的贡献文本。',
  filterResults: '筛选结果', invalidRealm: '请输入完整的领域 ID，以便在此视角中搜索。',
  resultsRegion: '搜索结果', results: '结果', resultsPrefix: '显示 ', resultsSuffix: ' 条结果',
  sequencePrefix: '完整结果截至序列 ', idle: '请至少输入两个字符。',
  loading: '正在搜索…', errorPrefix: '搜索暂不可用：', retry: '请稍后重试',
  empty: '没有找到匹配的作品。', workPrefix: '作品 ', mainVersion: '主版本',
  revision: '修订', workId: '作品 ID：', realmRelation: '领域关系', textMatch: '文本匹配',
  defaultReason: '已发布的贡献中包含该搜索词。',
};

export const auth = {
  chooseIdentity: '选择操作身份',
  identityHelp: '请输入您有权使用的身份。服务会逐项检查您的权限。',
  identityId: '身份 ID', invalidIdentity: '请输入完整的 REZICS 身份 ID。', continue: '继续',
  createAccountHeading: '创建 REZICS 账户', signInHeading: '登录 REZICS',
  accountHelp: '登录账户后可处理版本和贡献。',
  nameLabel: '姓名', email: '电子邮箱', password: '密码', accountFailed: '账户登录失败',
  connecting: '正在连接…', createAccount: '创建账户', signIn: '登录',
  newHere: '初次使用 REZICS？', alreadyHaveAccount: '已有账户？',
  createAccountLink: '创建账户',
};

export const work = {
  unavailable: '无法查看此修订。您的访问权限或来源服务可能已发生变化。',
  exactRevision: '精确修订', perspective: '视角', globalPerspective: '全局视角',
  perspectiveHelp: '此精确修订对应主版本记录。',
  mainVersion: '主版本', selectedVersion: '所选版本',
  metadataPrefix: '此元数据修订的标识为 ',
  metadataSuffix: '。',
  revisionDetails: '修订详情', work: '作品', operation: '操作',
  language: '语言', sequence: '序列',
};

export const studio = {
  createHeading: '创建作品',
  createHelp: '先填写标题。创建后可以添加贡献并作出领域决定。',
  workTitle: '作品标题', creating: '正在创建…', createWork: '创建作品',
  createdStatus: '作品已创建', createdHeading: '作品已创建。',
  createdSuffix: ' 及其主版本已保存。请保留这些 ID，以备后续编辑。',
  work: '作品', mainVersion: '主版本', revision: '修订', sourceSequence: '来源序列',
  titleError: '请输入不超过 200 个字符的标题。',
  denied: '此身份无权创建作品。',
  unavailable: '暂时无法创建作品。', noResult: '创建作品后未收到结果。',
  pending: '作品仍在核对中。请保留标题，稍后重试。',
};
