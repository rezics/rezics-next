// Machine-drafted; needs native review.
import { insert } from 'native-i18n';

export default {
  region: '你的封禁',
  title: '你被这个社区封禁了',
  endedTitle: '这次封禁已经结束',
  permanent: '这次封禁没有结束日期。',
  until: insert('这次封禁在 {{date}} 结束。', { date: String }),
  ended: insert('这次封禁已于 {{date}} 结束。', { date: String }),
  recorded: insert('封禁于 {{date}}。', { date: String }),
  reasonLabel: '记录的原因',
  appealTitle: '对这次封禁提出申诉',
  appealHelp: '你只能申诉一次。写下希望管理员重新考虑的理由。',
  statementLabel: '你的陈述',
  statementHint: '最多 2,000 个字符。',
  send: '提交申诉',
  statementEmpty: '先写下希望重新考虑的理由。',
  statementLong: '请控制在 2,000 个字符以内。',
  sendFailed: '申诉没有送出。你写的内容还在。',
  receivedTitle: '已收到申诉',
  receivedBody: '管理员已收到你的陈述。这次封禁不能再次申诉。',
  statementHeading: '你提交的内容',
  upheld: insert('管理员在 {{date}} 维持了这次封禁。', { date: String }),
  upheldUndated: '管理员维持了这次封禁。',
  lifted: insert('封禁已于 {{date}} 解除。', { date: String }),
  liftedUndated: '封禁已解除。',
  sharedLabel: '他们告知的理由',
};
