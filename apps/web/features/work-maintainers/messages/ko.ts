// Machine-drafted; needs native review.
import { insert } from 'native-i18n';
import type { WorkMaintainerMessages } from '../messages.ts';

const messages: WorkMaintainerMessages = {
  heading: '관리자',
  help: '이 작품을 편집할 수 있는 사람입니다. 목록에 있는 사람은 누구나 관리자를 추가할 수 있습니다. 제거할 수 있는 사람은 소유자뿐입니다.',
  owner: '소유자',
  addLabel: '관리자 추가',
  addHelp: '상대의 핸들(예: @lin_mei) 또는 주소.',
  add: '추가',
  remove: '제거',
  removeNamed: insert('{{name}} 제거', { name: String }),
  confirmTitle: insert('{{name}}을(를) 제거할까요?', { name: String }),
  confirmBody: insert('{{name}}은(는) 더 이상 이 작품을 편집할 수 없습니다. 이미 쓴 내용은 그대로 남습니다.', { name: String }),
  confirm: '제거',
  cancel: '취소',
  saved: '관리자 목록을 업데이트했습니다.',
  savedReplayed: '이 변경은 이미 기록되어 있습니다.',
  conflictTitle: '이 목록은 연 뒤에 바뀌었습니다',
  conflictBody: '그 밖에는 기록되지 않았습니다. 최신 목록을 다시 불러오세요. 입력한 내용은 여기에 남습니다.',
  reload: '최신 목록 불러오기',
  continuityTitle: '이 작품에는 마지막 관리자가 남습니다',
  continuityBody: '편집할 수 있는 사람이 있어야 합니다.',
  deniedTitle: '이 변경은 할 수 없습니다',
  deniedBody: '관리자를 제거할 수 있는 사람은 소유자뿐입니다. 추가는 어느 관리자나 할 수 있습니다.',
  signInTitle: '관리자를 바꾸려면 다시 로그인하세요',
  invalidTitle: '받아들여지지 않았습니다',
  unavailableTitle: '관리자를 변경하지 못했습니다',
  unavailableBody: '아무것도 바뀌지 않았습니다. 잠시 후 다시 시도하세요.',
  loadFailed: '관리자를 불러오지 못했습니다.',
  retry: '다시 시도',
  loading: '관리자를 불러오는 중',
  emptyQuery: '핸들 또는 주소를 입력하세요.',
  badTarget: '@lin_mei 같은 핸들 또는 그 정체성의 주소를 사용하세요.',
  notFound: '그 핸들을 쓰는 정체성이 없습니다.',
  already: insert('{{name}}은(는) 이미 이 작품의 관리자입니다.', { name: String }),
  self: '이미 이 작품의 관리자입니다.',
  mainSays: '이유',
};

export default messages;
