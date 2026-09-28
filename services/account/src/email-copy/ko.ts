import { plural } from './plural.ts';
import type { EmailCopy } from './types.ts';

const topics: Record<string, { other: string }> = {
  reply: { other: '답글 {n}개' },
  mention: { other: '언급 {n}건' },
  'post-vote': { other: '게시물 추천 {n}개' },
  'followed-chapter': { other: '새 챕터 {n}개' },
  'review-helpful': { other: '서평 추천 {n}개' },
  review: { other: '서평 {n}편' },
  'submission-decision': { other: '제출 결정 {n}건' },
  'moderation-outcome': { other: '처리 결과 {n}건' },
  'realm-role-change': { other: '역할 변경 {n}건' },
  'realm-membership-change': { other: '멤버 변경 {n}건' },
  'realm-invitation': { other: '커뮤니티 초대 {n}건' },
  'claim-correction': { other: '주장 정정 {n}건' },
  notification: { other: '알림 {n}개' },
};

const copy: EmailCopy = {
  verify: { subject: '이메일 주소 확인', body: '이 이메일 주소를 REZICS 계정에 사용할지 확인해 주세요.', action: '이메일 확인' },
  reset: { subject: '비밀번호 재설정', body: 'REZICS 계정의 새 비밀번호를 설정하세요. 이 링크는 30분 후에 만료됩니다.', action: '비밀번호 재설정' },
  'change-email': { subject: '이메일 변경 확인', body: 'REZICS 이메일 변경 요청을 확인해 주세요. 이후 새 주소도 확인해야 합니다.', action: '변경 확인' },
  notice: { subject: 'REZICS 계정에 대한 메시지', body: 'REZICS 팀이 계정에 대해 다음 메시지를 보냈습니다.', action: 'REZICS 계정 열기' },
  digest: { subject: 'REZICS 알림 요약', body: '오늘의 알림 요약입니다.', action: 'REZICS 열기' },
  ignore: '요청하지 않았다면 이 메일을 무시하세요.',
  digestMore: '더 많은 알림은 REZICS에서 확인할 수 있습니다.',
  digestLine: (topic, count) => plural('ko', count, topics[topic] ?? topics.notification!),
};

export default copy;
