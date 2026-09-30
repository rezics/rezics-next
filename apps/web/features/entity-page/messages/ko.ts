import { insert } from 'native-i18n';
import type { EntityPageMessages } from '../messages.ts';

export default {
  pageUnavailableTitle: '지금은 이 페이지를 표시할 수 없습니다',
  pageUnavailableBody: 'REZICS가 이 기록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
  notFoundTitle: '여기에는 아무것도 없습니다',
  notFoundBody: '이 주소의 자원이 없거나 볼 수 없습니다.',
  restricted: '비공개', restrictedHelp: '접근 권한을 받은 사람만 볼 수 있습니다.',

  sections: '섹션',
  statements: '진술', statementsUnavailable: '진술을 불러오지 못했습니다.',
  noStatements: '아직 진술이 없습니다', noStatementsBody: '아직 승인된 내용이 없습니다.',
  statementsList: '진술',
  valueSome: '알 수 없는 값', valueNone: '값 없음',
  relations: '관계', relationsUnavailable: '관계를 불러오지 못했습니다.',
  noRelations: '아직 관계가 없습니다', noRelationsBody: '아직 이것과 관련된 항목이 없습니다.',
  relationsSignIn: '로그인하면 관련 항목을 볼 수 있습니다.',
  relationsIdentity: '신원을 선택하면 관련 항목을 볼 수 있습니다.',
  discussion: '토론',
  startDiscussion: insert('이 {{subject}}에 대해 토론하기', { subject: String }),
  ratingsFor: insert('이 {{subject}}에 대한 평점', { subject: String }),
  reviewsFor: insert('이 {{subject}}에 대한 리뷰', { subject: String }),
  ratingsReadOnly: '아직 이것에 평점을 주거나 리뷰를 쓸 수 없습니다.',
  noRatings: '아직 평점이 없습니다.',
  unavailable: '사용할 수 없음', unnamed: '이름 없음', search: '검색',
} satisfies EntityPageMessages;
