// Sign-in, acting identity and account menu strings. `{agent}` placeholders
// are filled with `formatMessage`; messages stay plain strings so server pages
// can pass them to client components.

const en = {
  // Sign in and create account.
  signInHeading: 'Sign in to REZICS',
  createAccountHeading: 'Create your REZICS account',
  accountHelp: 'Use your account to work with versions and contributions.',
  nameLabel: 'Name', email: 'Email', password: 'Password',
  accountFailed: 'Account sign-in failed', connecting: 'Connecting…',
  createAccount: 'Create account', signIn: 'Sign in',
  newHere: 'New to REZICS?', alreadyHaveAccount: 'Already have an account?',
  createAccountLink: 'Create an account',
  // Choosing the session Agent.
  chooseAgentHeading: 'Choose who you act as',
  chooseAgentHelp: 'Your account can act as these Agents. The one you choose is shown as signed in across REZICS and proposed for what you do there. Each action is still checked when you take it.',
  agentsLegend: 'Agents you can act as',
  agentFallback: 'Agent {agent}',
  representedPath: 'Represented Agent', directPath: 'Your own Agent',
  currentAgent: 'Current', defaultAgent: 'Default',
  saveDefault: 'Make this my default',
  saveDefaultHelp: 'New sign-ins start with it, and new Works propose it.',
  useAgent: 'Use this Agent',
  ineligibleAgent: 'You were acting as {agent}, which you can no longer use. Nothing was switched for you: choose an Agent to continue.',
  noAgents: 'Your account cannot act as any Agent yet.',
  agentsUnavailable: 'Your Agents cannot be listed right now. Try again in a moment.',
  invalidAgent: 'That Agent is not available to you. Choose one from the list.',
  staleDefault: 'Your default was changed somewhere else. Review the list and try again.',
  defaultNotSaved: 'You now act as the chosen Agent, but your default could not be saved.',
  // Account menu.
  accountMenu: 'Account menu', actingAs: 'Acting as', switchAgent: 'Switch Agent',
  chooseAgent: 'Choose an Agent', agentNotEligible: 'Agent no longer available',
  noAgent: 'No Agent yet', agentUnverified: 'Agent not checked', signOut: 'Sign out',
};

export type AuthMessages = typeof en;

const zhCN: AuthMessages = {
  signInHeading: '登录 REZICS',
  createAccountHeading: '创建 REZICS 账户',
  accountHelp: '登录账户后可处理版本和贡献。',
  nameLabel: '姓名', email: '电子邮箱', password: '密码',
  accountFailed: '账户登录失败', connecting: '正在连接…',
  createAccount: '创建账户', signIn: '登录',
  newHere: '初次使用 REZICS？', alreadyHaveAccount: '已有账户？',
  createAccountLink: '创建账户',
  chooseAgentHeading: '选择您的操作身份',
  chooseAgentHelp: '您的账户可以代表以下身份操作。所选身份会在 REZICS 各处显示为当前登录身份，并预填到您的操作中。每项操作在执行时仍会单独检查权限。',
  agentsLegend: '可用的操作身份',
  agentFallback: '身份 {agent}',
  representedPath: '受托代表的身份', directPath: '您本人的身份',
  currentAgent: '当前', defaultAgent: '默认',
  saveDefault: '设为我的默认身份',
  saveDefaultHelp: '新的登录会以此身份开始，新建作品时也会预选它。',
  useAgent: '使用此身份',
  ineligibleAgent: '您之前使用的身份 {agent} 已不可用。系统没有替您更换身份，请选择一个身份后继续。',
  noAgents: '您的账户目前还不能代表任何身份操作。',
  agentsUnavailable: '暂时无法列出您的操作身份，请稍后再试。',
  invalidAgent: '您不能使用该身份，请从列表中选择。',
  staleDefault: '您的默认身份已在别处更改。请检查列表后重试。',
  defaultNotSaved: '已切换到所选身份，但未能保存为默认身份。',
  accountMenu: '账户菜单', actingAs: '当前身份', switchAgent: '切换身份',
  chooseAgent: '选择身份', agentNotEligible: '身份已不可用',
  noAgent: '尚无身份', agentUnverified: '身份未经检查', signOut: '退出登录',
};

export const authMessages = { en, 'zh-CN': zhCN } as const;

export function formatMessage(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}
