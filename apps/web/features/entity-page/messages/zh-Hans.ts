import { insert } from 'native-i18n';
import type { EntityPageMessages } from '../messages.ts';

export default {
  pageUnavailableTitle: '暂时无法显示此页面',
  pageUnavailableBody: 'REZICS 无法读取这条记录，请稍后再试。',
  notFoundTitle: '这里没有内容',
  notFoundBody: '没有资源使用这个地址，或你无法查看。',
  restricted: '私有', restrictedHelp: '只有获得授权的人可以查看。',

  sections: '分区',
  statements: '陈述', statementsUnavailable: '无法加载陈述。',
  noStatements: '暂无陈述', noStatementsBody: '目前还没有被接受的陈述。',
  statementsList: '陈述',
  valueSome: '未知的值', valueNone: '无值',
  relations: '关系', relationsUnavailable: '无法加载关系。',
  noRelations: '暂无关系', noRelationsBody: '目前还没有与此相关的内容。',
  relationsSignIn: '登录后可查看与此相关的内容。',
  relationsIdentity: '选择身份后可查看与此相关的内容。',
  discussion: '讨论',
  startDiscussion: insert('讨论此{{subject}}', { subject: String }),
  ratingsFor: insert('此{{subject}}的评分', { subject: String }),
  reviewsFor: insert('此{{subject}}的书评', { subject: String }),
  ratingsReadOnly: '目前尚未开放为此评分或撰写书评。',
  noRatings: '暂无评分。',
  unavailable: '不可用', unnamed: '未命名', search: '搜索',
} satisfies EntityPageMessages;
