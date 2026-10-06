import type { AccountLocale } from './email.ts';

/** A notice goes only to the invited mailbox, never back to the inviter. */
export function guardianInvitationMessage(locale: AccountLocale, ownerEmail: string): string {
  const copy: Record<AccountLocale, (owner: string) => string> = {
    en: (owner) =>
      `${owner} invited you to be their account recovery guardian. You can accept or decline in Accounts. Accepting lets you approve recovery with their saved code; it prevents deleting your account until you withdraw or the code is used. You can withdraw at any time. This invitation expires in 7 days. Ignore it if you do not know this person.`,
    'zh-Hans': (owner) =>
      `${owner} 邀请你成为账号恢复守护人。你可以在账号中心接受或拒绝。接受后，你可以配合对方保存的恢复码批准恢复；在退出或恢复码被使用前，你无法删除自己的账号。你可以随时退出。邀请将在 7 天后到期。如果不认识对方，请忽略此邮件。`,
    'zh-Hant': (owner) =>
      `${owner} 邀請你成為帳號復原守護人。你可以在帳號中心接受或拒絕。接受後，你可以配合對方保存的復原碼批准復原；在退出或復原碼被使用前，你無法刪除自己的帳號。你可以隨時退出。邀請將在 7 天後到期。如果不認識對方，請忽略此郵件。`,
    ja: (owner) =>
      `${owner} さんがアカウント復旧の協力者としてあなたを招待しました。アカウントで承諾または辞退できます。承諾すると、保存された復旧コードと併せて復旧を承認できます。辞退するかコードが使われるまで、自分のアカウントは削除できません。いつでも協力をやめられます。招待は7日後に期限切れになります。知らない相手なら無視してください。`,
    ko: (owner) =>
      `${owner} 님이 계정 복구 보호자로 초대했습니다. 계정에서 수락하거나 거절할 수 있습니다. 수락하면 저장된 복구 코드와 함께 복구를 승인할 수 있으며, 보호자 역할을 그만두거나 코드가 사용될 때까지 계정을 삭제할 수 없습니다. 언제든 그만둘 수 있습니다. 초대는 7일 후 만료됩니다. 모르는 사람이라면 무시하세요.`,
    de: (owner) =>
      `${owner} hat dich zur Kontowiederherstellung eingeladen. Du kannst in Accounts annehmen oder ablehnen. Nach der Annahme kannst du mit dem gespeicherten Code eine Wiederherstellung bestätigen. Dein Konto lässt sich erst löschen, wenn du zurücktrittst oder der Code verwendet wurde. Du kannst jederzeit zurücktreten. Die Einladung gilt 7 Tage. Ignoriere sie, wenn du die Person nicht kennst.`,
    fr: (owner) =>
      `${owner} vous invite à devenir son contact de récupération. Vous pouvez accepter ou refuser dans Accounts. Après acceptation, vous pouvez approuver une récupération avec son code enregistré. Vous devez vous retirer ou attendre l’utilisation du code avant de supprimer votre compte. Vous pouvez vous retirer à tout moment. L’invitation expire dans 7 jours. Ignorez-la si vous ne connaissez pas cette personne.`,
    es: (owner) =>
      `${owner} te invita a ser su contacto de recuperación. Puedes aceptar o rechazar en Accounts. Al aceptar, puedes aprobar la recuperación junto con su código guardado. No podrás eliminar tu cuenta hasta que te retires o se use el código. Puedes retirarte cuando quieras. La invitación caduca en 7 días. Ignórala si no conoces a esta persona.`,
  };
  return copy[locale](ownerEmail);
}
