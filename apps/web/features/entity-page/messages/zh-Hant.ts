import { insert } from 'native-i18n';
import type { EntityPageMessages } from '../messages.ts';

export default {
  pageUnavailableTitle: '目前無法顯示此頁面',
  pageUnavailableBody: 'REZICS 無法讀取這筆記錄，請稍後再試。',
  notFoundTitle: '這裡沒有內容',
  notFoundBody: '沒有資源使用這個網址，或你無法查看。',
  restricted: '私人', restrictedHelp: '只有獲授權的人可以查看。',

  sections: '區段',
  statements: '陳述', statementsUnavailable: '無法載入陳述。',
  noStatements: '尚無陳述', noStatementsBody: '目前還沒有被接受的陳述。',
  statementsList: '陳述',
  valueSome: '未知的值', valueNone: '無值',
  relations: '關係', relationsUnavailable: '無法載入關係。',
  noRelations: '尚無關係', noRelationsBody: '目前還沒有與此相關的項目。',
  relationsSignIn: '登入後可查看與此相關的項目。',
  relationsIdentity: '選擇身分後可查看與此相關的項目。',
  discussion: '討論',
  startDiscussion: insert('討論此{{subject}}', { subject: String }),
  ratingsFor: insert('此{{subject}}的評分', { subject: String }),
  reviewsFor: insert('此{{subject}}的書評', { subject: String }),
  ratingsReadOnly: '目前尚未開放為此評分或撰寫書評。',
  noRatings: '尚無評分。',
  unavailable: '無法使用', unnamed: '未命名', search: '搜尋',
} satisfies EntityPageMessages;
