import type { OnboardingMessages } from '../messages.ts';

export default {
  welcome: 'REZICS에 오신 것을 환영합니다',
  welcomeHelp: '프로필에 사용할 사용자 이름을 정해 주세요. 사용자 이름과 함께 공개 이름이 표시됩니다.',
  displayName: '표시 이름',
  displayNameHelp: 'REZICS 계정에서 가져온 이름입니다.',
  handle: '사용자 이름',
  handleHelp: '영문자, 숫자, 밑줄(_)을 사용해 3~30자로 입력하세요. 대소문자를 구분하지 않습니다.',
  checking: '사용할 수 있는지 확인 중…',
  available: '사용할 수 있는 사용자 이름입니다.',
  current: '현재 사용 중인 사용자 이름입니다.',
  taken: '이미 사용 중인 사용자 이름입니다. 다른 이름을 입력해 주세요.',
  reserved: '사용할 수 없는 사용자 이름입니다. 다른 이름을 입력해 주세요.',
  invalid: '영문자, 숫자, 밑줄(_)을 사용해 3~30자로 입력하세요.',
  checkFailed: '사용자 이름을 확인하지 못했습니다. 다시 시도해 주세요.',
  continue: '홈으로 이동',
  pending: '프로필을 준비하고 있습니다',
  pendingHelp: '보통 잠시만 기다리면 됩니다. 로그인 정보는 저장되었습니다.',
  retry: '다시 시도',
  failed: '프로필을 설정하지 못했습니다. 다시 시도해 주세요.',
  changeConflict: '사용자 이름이 변경되었거나 사용할 수 없게 되었습니다. 다시 확인해 주세요.',
} satisfies Partial<OnboardingMessages>;
