// Machine-drafted; needs native review.
import { insert } from 'native-i18n';
import type { WorkMaintainerMessages } from '../messages.ts';

const messages: WorkMaintainerMessages = {
  heading: '维护者',
  help: '可以编辑这部作品的人。名单上的任何人都能添加维护者。只有拥有者能移除维护者。',
  owner: '拥有者',
  addLabel: '添加维护者',
  addHelp: '对方的账号，例如 @lin_mei，或对方的地址。',
  add: '添加',
  remove: '移除',
  removeNamed: insert('移除{{name}}', { name: String }),
  confirmTitle: insert('要移除{{name}}吗？', { name: String }),
  confirmBody: insert('{{name}}将不能再编辑这部作品。已经写下的内容会保留。', { name: String }),
  confirm: '移除',
  cancel: '取消',
  saved: '维护者名单已更新。',
  savedReplayed: '这项变更先前已经记录。',
  conflictTitle: '这份名单在你打开之后有了变动',
  conflictBody: '没有再写入其他变更。请重新加载最新名单。你输入的内容会留在这里。',
  reload: '重新加载最新名单',
  continuityTitle: '这部作品会保留最后一位维护者',
  continuityBody: '必须有人能继续编辑它。',
  deniedTitle: '你不能做这项变更',
  deniedBody: '只有拥有者能移除维护者。任何维护者都能添加一位。',
  signInTitle: '请重新登录后再变更维护者',
  invalidTitle: '这项没有被接受',
  unavailableTitle: '无法变更维护者',
  unavailableBody: '没有任何变更。请稍后再试。',
  loadFailed: '无法加载维护者。',
  retry: '重试',
  loading: '正在加载维护者',
  emptyQuery: '请输入账号或地址。',
  badTarget: '请使用账号，例如 @lin_mei，或该身份的地址。',
  notFound: '没有身份使用这个账号。',
  already: insert('{{name}}已经是这部作品的维护者。', { name: String }),
  self: '你已经是这部作品的维护者。',
  mainSays: '原因',
};

export default messages;
