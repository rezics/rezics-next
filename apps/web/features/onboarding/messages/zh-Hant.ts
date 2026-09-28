import type { OnboardingMessages } from '../messages.ts';

export default {
  welcome: '歡迎使用 REZICS',
  welcomeHelp: '為您的個人檔案選擇使用者名稱；公開名稱會一併顯示。',
  displayName: '顯示名稱',
  displayNameHelp: '此名稱來自您的 REZICS 帳戶。',
  handle: '您的使用者名稱',
  handleHelp: '請使用 3–30 個英文字母、數字或底線。使用者名稱不區分大小寫。',
  checking: '正在檢查是否可用…',
  available: '此使用者名稱可以使用。',
  current: '這是您目前的使用者名稱。',
  taken: '此使用者名稱已有人使用，請換一個。',
  reserved: '無法使用此使用者名稱，請換一個。',
  invalid: '請使用 3–30 個英文字母、數字或底線。',
  checkFailed: '無法檢查此使用者名稱，請再試一次。',
  continue: '前往首頁',
  pending: '正在準備您的個人檔案',
  pendingHelp: '通常只需要一點時間。您的登入狀態已儲存。',
  retry: '再試一次',
  failed: '無法完成個人檔案設定，請再試一次。',
  changeConflict: '此使用者名稱已變更或無法使用，請重新檢查。',
} satisfies Partial<OnboardingMessages>;
