import { providerScopes } from './oauth-scopes.ts';

type Description = { en: string; 'zh-CN': string };
const words: Record<string, [string, string]> = {
  work: ['works', '作品'], comment: ['comments', '评论'], space: ['spaces', '空间'],
  realm: ['community submissions', '社区投稿'], classification: ['classifications', '分类'],
  rating: ['ratings', '评分'], address: ['addresses', '地址'], access: ['access permissions', '访问权限'],
  source: ['source material', '来源资料'], package: ['packages', '软件包'], agent: ['agents', '代理身份'],
  subscription: ['subscriptions', '订阅'], 'connected-app': ['connected apps', '关联应用'],
  context: ['contexts', '语境'], event: ['event observations', '事件观测'], export: ['exports', '导出'],
  governance: ['community reports and decisions', '社区报告与决定'], judgment: ['judgments', '评价'],
  notification: ['notifications', '通知'], owner: ['storage ownership', '存储归属'],
  content: ['content', '内容'], rights: ['usage rights', '使用权'], statement: ['statements', '陈述'],
  theme: ['executable themes', '可执行主题'], claim: ['verification claims', '核验主张'],
  vote: ['polls and ballots', '投票与选票'], zone: ['zones', '分区'],
  collection: ['collections', '集合'], semantic: ['semantic relationships', '语义关系'],
};
const actions: Record<string, [string, string]> = {
  create: ['Create', '创建'], edit: ['Edit', '编辑'], read: ['Read', '读取'], adopt: ['Adopt', '采纳'],
  reject: ['Reject', '拒绝'], classify: ['Classify', '分类'], define: ['Define', '定义'],
  decide: ['Make decisions about', '决定'], configure: ['Configure', '配置'], submit: ['Submit', '提交'],
  claim: ['Claim', '认领'], manage: ['Manage', '管理'], 'membership-consent': ['Consent to membership through', '同意成员资格相关的'],
  approve: ['Approve', '批准'], grant: ['Grant', '授予'], represent: ['Act with represented', '代表使用'],
  'representation-manage': ['Manage representation for', '管理委托相关的'], role: ['Manage roles for', '管理角色相关的'],
  intake: ['Register', '登记'], acquire: ['Acquire', '获取'], convert: ['Convert', '转换'],
  propose: ['Propose', '提议'], correspond: ['Link', '关联'], capture: ['Capture', '记录'],
  resolve: ['Resolve dependencies for', '解析依赖相关的'], verify: ['Verify', '验证'],
  observe: ['Observe', '观测'], consent: ['Grant consent to', '授权'], invoke: ['Run', '运行'],
  write: ['Write', '编写'], select: ['Select', '选择'], report: ['Submit', '提交'],
  operate: ['Operate', '操作'], install: ['Install', '安装'], revoke: ['Revoke', '撤销'],
  'recommendation-set': ['Set recommendations for', '设置推荐相关的'], protect: ['Protect', '保护'],
  correct: ['Correct', '更正'], review: ['Review', '审查'], assess: ['Assess', '评估'],
  offer: ['Offer', '提供'], evidence: ['Attach evidence to', '为以下内容提供证据：'],
  challenge: ['Challenge', '质疑'], lineage: ['Trace the lineage of', '追踪来源：'],
  reliability: ['Assess the reliability of', '评估可信度：'], cast: ['Cast', '提交'], invalidate: ['Invalidate', '作废'],
};
const identity: Record<string, Description> = {
  openid: { en: 'Identify your REZICS account', 'zh-CN': '识别你的 REZICS 账号' },
  profile: { en: 'Read your name and profile image', 'zh-CN': '读取你的姓名和头像' },
  email: { en: 'Read your email address and verification status', 'zh-CN': '读取你的邮箱地址与验证状态' },
  offline_access: { en: 'Keep access while you are signed out, until you revoke it', 'zh-CN': '在你退出登录后继续访问，直到你撤销授权' },
  // Scopes whose meaning is not "<action> <owner noun>" get an exact description.
  'realm:profile': { en: "Publish the public profile of communities you manage", 'zh-CN': '发布你管理的社区的公开资料' },
  'realm:public-role': { en: 'Show or hide your public moderator role in communities', 'zh-CN': '公开或隐藏你在社区中的版主身份' },
};

/** No silent untranslated fallback: a new scope must define what the person
 * is authorizing. Descriptions explain capability; Access still admits each operation. */
export function describeScope(scope: string): { scope: string; description: Description } {
  if (identity[scope]) return { scope, description: identity[scope] };
  const [owner, action] = scope.split(':');
  const noun = words[owner!];
  const verb = actions[action!];
  if (!noun || !verb) throw new Error(`Missing consent description: ${scope}`);
  return { scope, description: { en: `${verb[0]} ${noun[0]}`, 'zh-CN': `${verb[1]}${noun[1]}` } };
}
export const scopeDescriptions = Object.freeze(providerScopes.map(describeScope));
