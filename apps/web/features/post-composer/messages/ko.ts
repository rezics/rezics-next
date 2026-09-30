import type { PostMessages } from '../messages.ts';

export default {
  title: '게시글 작성', intro: '커뮤니티에서 대화를 시작하세요.', community: '커뮤니티',
  communitySearch: '커뮤니티 찾기', communityChange: '커뮤니티 변경', work: '작품',
  workSearch: '작품 검색', workChange: '작품 변경', titleLabel: '제목', body: '게시글 내용',
  edit: '작성', preview: '미리보기', showSpoiler: '스포일러 표시',
  bodyHelp: '이야기하고 싶은 세부 내용, 질문 또는 생각을 작성하세요.', spoiler: '스포일러로 표시',
  spoilerHelp: '본문을 보여 주기 전에 독자에게 스포일러가 있음을 알립니다.', rules: '커뮤니티 규칙',
  noRules: '이 커뮤니티에는 아직 게시된 규칙이 없습니다.',
  reviewRequired: '이 커뮤니티는 게시 전에 게시글을 검토합니다. 여기서는 바로 게시할 수 없습니다.',
  joinRequired: '게시하기 전에 이 커뮤니티에 가입하세요.', viewCommunity: '커뮤니티 보기',
  post: '게시', posting: '게시 중…', draftSaved: '이 기기에 초안을 저장했습니다',
  failed: '게시하지 못했습니다. 초안은 그대로 남아 있으니 다시 시도하세요.',
  refused: '커뮤니티에서 게시글을 받아들이지 않았습니다. 규칙과 설정을 확인하세요.',
  unavailable: '커뮤니티를 불러오지 못했습니다. 다시 시도하세요.',
  noCommunity: '일치하는 커뮤니티가 없습니다', noWork: '일치하는 작품이 없습니다',
  signIn: '게시하려면 로그인하세요', agentNeeded: '게시하기 전에 개인 프로필을 선택하세요.',
  createWork: '작품 만들기',
} satisfies PostMessages;
