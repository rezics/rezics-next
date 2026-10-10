// Machine-drafted; needs native review.
import { insert } from 'native-i18n';
import type { WorkMaintainerMessages } from '../messages.ts';

const messages: WorkMaintainerMessages = {
  heading: '維護者',
  help: '可以編輯這部作品的人。名單上的任何人都能新增維護者。只有擁有者能移除維護者。',
  owner: '擁有者',
  addLabel: '新增維護者',
  addHelp: '對方的帳號，例如 @lin_mei，或對方的地址。',
  add: '新增',
  remove: '移除',
  removeNamed: insert('移除{{name}}', { name: String }),
  confirmTitle: insert('要移除{{name}}嗎？', { name: String }),
  confirmBody: insert('{{name}}將不能再編輯這部作品。已經寫下的內容會保留。', { name: String }),
  confirm: '移除',
  cancel: '取消',
  saved: '維護者名單已更新。',
  savedReplayed: '這項變更先前已經記錄。',
  conflictTitle: '這份名單在你打開之後有了變動',
  conflictBody: '沒有再寫入其他變更。請重新載入最新名單。你輸入的內容會留在這裡。',
  reload: '重新載入最新名單',
  continuityTitle: '這部作品會保留最後一位維護者',
  continuityBody: '必須有人能繼續編輯它。',
  deniedTitle: '你不能做這項變更',
  deniedBody: '只有擁有者能移除維護者。任何維護者都能新增一位。',
  signInTitle: '請重新登入後再變更維護者',
  invalidTitle: '這項沒有被接受',
  unavailableTitle: '無法變更維護者',
  unavailableBody: '沒有任何變更。請稍後再試。',
  loadFailed: '無法載入維護者。',
  retry: '重試',
  loading: '正在載入維護者',
  emptyQuery: '請輸入帳號或地址。',
  badTarget: '請使用帳號，例如 @lin_mei，或該身份的地址。',
  notFound: '沒有身份使用這個帳號。',
  already: insert('{{name}}已經是這部作品的維護者。', { name: String }),
  self: '你已經是這部作品的維護者。',
  mainSays: '原因',
};

export default messages;
