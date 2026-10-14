import type { UiLocale } from '../../i18n/define.ts';

type ReviewCopy = { title: string; dismiss: string; restore: string; share: string; dismissHelp: string; restoreHelp: string };
/** Local sanction review is distinct from content moderation; restoration lifts the ban. */
export const reviewText: Record<UiLocale, ReviewCopy> = {
  en: { title: 'Ban appeal', dismiss: 'Uphold ban', restore: 'Lift ban', share: 'Share the reason with the appellant',
    dismissHelp: 'The ban remains in place. This closes the appeal.', restoreHelp: 'This ends the ban immediately and closes the appeal.' },
  'zh-Hans': { title: '封禁申诉', dismiss: '维持封禁', restore: '解除封禁', share: '向申诉人公开理由',
    dismissHelp: '封禁继续有效，申诉将结案。', restoreHelp: '立即解除封禁并结束申诉。' },
  'zh-Hant': { title: '封禁申訴', dismiss: '維持封禁', restore: '解除封禁', share: '向申訴人公開理由',
    dismissHelp: '封禁繼續有效，申訴將結案。', restoreHelp: '立即解除封禁並結束申訴。' },
  ja: { title: '利用停止への異議申立て', dismiss: '利用停止を維持', restore: '利用停止を解除', share: '理由を申立人に伝える',
    dismissHelp: '利用停止を維持し、異議申立てを終了します。', restoreHelp: '利用停止を直ちに解除し、異議申立てを終了します。' },
  ko: { title: '차단 이의 제기', dismiss: '차단 유지', restore: '차단 해제', share: '이의 제기자에게 사유 공개',
    dismissHelp: '차단을 유지하고 이의 제기를 종결합니다.', restoreHelp: '즉시 차단을 해제하고 이의 제기를 종결합니다.' },
  de: { title: 'Einspruch gegen die Sperre', dismiss: 'Sperre bestätigen', restore: 'Sperre aufheben', share: 'Begründung mit der betroffenen Person teilen',
    dismissHelp: 'Die Sperre bleibt bestehen. Der Einspruch wird geschlossen.', restoreHelp: 'Die Sperre endet sofort und der Einspruch wird geschlossen.' },
  fr: { title: 'Recours contre le bannissement', dismiss: 'Maintenir le bannissement', restore: 'Lever le bannissement', share: 'Partager le motif avec la personne concernée',
    dismissHelp: 'Le bannissement est maintenu et le recours est clos.', restoreHelp: 'Le bannissement prend fin immédiatement et le recours est clos.' },
  es: { title: 'Apelación del bloqueo', dismiss: 'Mantener el bloqueo', restore: 'Levantar el bloqueo', share: 'Compartir el motivo con la persona que apela',
    dismissHelp: 'El bloqueo se mantiene y la apelación se cierra.', restoreHelp: 'El bloqueo termina de inmediato y la apelación se cierra.' },
};
