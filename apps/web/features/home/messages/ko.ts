import { asValue, insert, number, plural } from 'native-i18n';
import type { HomeMessages } from '../messages.ts';

export default {
  title: '홈',

  // Continue
  continueTitle: '이어서 읽기',
  newChapters: plural({ one: insert('새 챕터 {{count}}개'), other: insert('새 챕터 {{count}}개') }, { count: asValue(number()) }),
  newChaptersAtLeast: plural({ one: insert('새 챕터 {{count}}개 이상'), other: insert('새 챕터 {{count}}개 이상') },
    { count: asValue(number()) }),
  nextChapter: insert('다음: {{chapter}}', { chapter: String }), nextUp: '읽던 곳부터 이어 읽기',
  continueWork: insert('“{{title}}” 이어 읽기', { title: String }),
  hideFromContinue: insert('이어서 읽기에서 “{{title}}” 숨기기', { title: String }),
  hiddenFromContinue: insert('“{{title}}”은 이어서 읽기에서 숨겨졌어요.', { title: String }),
  hideFailed: '숨기지 못했어요. 다시 시도해 보세요.', undo: '실행 취소',
  scrollBack: '이전으로 스크롤', scrollForward: '다음으로 스크롤',

  // Signed out
  welcomeTitle: '커뮤니티를 팔로우해 나만의 홈을 만들어 보세요',
  welcomeBody: '좋아하는 작품이 있는 커뮤니티에 참여하세요. 새 챕터와 추천 작품, 토론이 이 페이지에 모입니다.',
  signUp: 'REZICS 가입', signIn: '로그인', dismiss: '닫기',
  officialZones: '공식 Zone', officialZonesIntro: 'REZICS가 운영하는 커뮤니티에서 큐레이션',

  // Suggestions
  reasonPopular: 'REZICS 인기',
  members: plural({ one: insert('회원 {{count}}명'), other: insert('회원 {{count}}명') }, { count: asValue(number()) }),
  membersAbout: plural({ one: insert('회원 약 {{count}}명'), other: insert('회원 약 {{count}}명') },
    { count: asValue(number()) }),

  // The rail
  sidebar: 'REZICS 더 둘러보기',
  trendingFollowed: '내 커뮤니티 인기 게시물', trendingGlobal: '이번 주 인기',
  trendingEmpty: '이번 주에는 아직 인기 게시물이 없어요.',
  realmsToFollow: '팔로우할 커뮤니티', popularRealms: '인기 커뮤니티',
  follow: '팔로우', followed: '팔로잉', followRealm: insert('{{realm}} 팔로우', { realm: String }),
  followOneFailed: '팔로우하지 못했어요. 다시 시도해 보세요.',
  queueTitle: '내 검토 대기열',
  queueWaiting: insert('{{count}}건 대기 중', { count: String }), queueClear: '대기 중인 항목이 없어요.',
  openManage: '관리 열기',
  howHomeWorks: '홈 작동 방식',
  howBest: insert('베스트는 독자의 투표를 기준으로 게시물 순위를 매기고, 약 {{hours}}시간 동안 시간이 지날수록 가중치를 낮춰 같은 커뮤니티의 게시물끼리 비교합니다.',
    { hours: String }),
  howCap: insert('연속된 게시물 {{window}}개 중 {{cap}}개를 넘는 게시물이 한 커뮤니티에서 나오지 않도록 제한합니다.', { cap: String, window: String }),
  howNew: '최신순은 새 게시물부터 차례로 표시합니다. 인기순은 선택한 기간의 투표 수를 기준으로 합니다.',
  howFollowing: '팔로우 중인 커뮤니티, Zone, 작품이 표시됩니다. 조용한 경우에만 추천이 나타나며 추천임을 표시합니다.',
} satisfies Partial<HomeMessages>;
