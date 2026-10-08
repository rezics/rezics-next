// Machine-drafted; needs native review.
import { insert } from 'native-i18n';

export default {
  region: '你的封鎖',
  title: '你被這個社群封鎖了',
  endedTitle: '這次封鎖已經結束',
  permanent: '這次封鎖沒有結束日期。',
  until: insert('這次封鎖在 {{date}} 結束。', { date: String }),
  ended: insert('這次封鎖已於 {{date}} 結束。', { date: String }),
  recorded: insert('封鎖於 {{date}}。', { date: String }),
  reasonLabel: '記錄的原因',
  appealTitle: '對這次封鎖提出申訴',
  appealHelp: '你只能申訴一次。寫下希望管理員重新考慮的理由。',
  statementLabel: '你的陳述',
  statementHint: '最多 2,000 個字元。',
  send: '送出申訴',
  statementEmpty: '先寫下希望重新考慮的理由。',
  statementLong: '請控制在 2,000 個字元以內。',
  sendFailed: '申訴沒有送出。你寫的內容還在。',
  receivedTitle: '已收到申訴',
  receivedBody: '管理員已收到你的陳述。這次封鎖不能再次申訴。',
  statementHeading: '你送出的內容',
  upheld: insert('管理員在 {{date}} 維持了這次封鎖。', { date: String }),
  upheldUndated: '管理員維持了這次封鎖。',
  lifted: insert('封鎖已於 {{date}} 解除。', { date: String }),
  liftedUndated: '封鎖已解除。',
  sharedLabel: '他們告知的理由',
};
