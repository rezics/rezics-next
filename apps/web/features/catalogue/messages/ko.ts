import { asValue, insert, number, plural } from 'native-i18n';
import type { CatalogueMessages } from '../messages.ts';

export default {
  untitled: insert('작품 {{id}}', { id: String }),
  fallbackTitle: '다른 언어로 표시된 제목',
  ratingCount: plural({ one: insert('평점 {{count}}개'), other: insert('평점 {{count}}개') }, { count: asValue(number()) }),
  averageRating: insert('평균 평점 {{mean}} / {{max}} · {{count}}', { mean: String, max: String, count: String }),
  ownRating: insert('내 평점: {{max}}점 만점에 {{value}}점', { value: String, max: String }),
  yourRating: '내 평점',
  noRatings: '아직 평점이 없습니다',
  previous: '이전', next: '다음', seeAll: '모두 보기',
  wantToRead: '읽고 싶어요', reading: '읽는 중', read: '읽었어요',
  removeFromShelf: '내 책장에서 삭제',
  shelve: insert('“{{title}}” 책장에 담기', { title: String }),
  shelfOptions: '다른 책장',
  signInToShelve: '읽을 목록을 만들려면 로그인하세요',
  rateThis: '이 작품 평가하기',
  signInToRate: '평가하려면 로그인하세요',
  saving: '저장 중…',
  saveFailed: '저장하지 못했습니다. 다시 시도해 주세요.',
  ratingProcessing: '평점이 아직 처리 중입니다.',
  refresh: '새로고침',
  ongoing: '연재 중', hiatus: '휴재 중',
  whyItsHere: '선정 이유', openRecipe: '레시피 열기', install: '설치', copyPrompt: '프롬프트 복사',
  promptCopied: '프롬프트를 복사했습니다', copyFailed: '복사하지 못했습니다. 다시 시도해 주세요.',
} satisfies Partial<CatalogueMessages>;
