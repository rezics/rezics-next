/** Mounted presentation only. No request operands or browser persistence belong here. */
export type ConsentOutcome = 'unknown' | 'unattributed' | 'acknowledged' | 'refused' | 'declined';
export type ConsentNotice = Readonly<{ outcome: ConsentOutcome }>;
export type ConsentNotices = Readonly<{ first?: ConsentNotice; latest?: ConsentNotice }>;
const unresolved = (notice?: ConsentNotice) => notice?.outcome === 'unknown' || notice?.outcome === 'unattributed';

export function createConsentRequestReturn(publish: (notices: ConsentNotices) => void) {
  let notices: ConsentNotices = {};
  return {
    remember(outcome: ConsentOutcome) {
      const notice = { outcome };
      if (unresolved(notice) && !notices.first) notices = { first: notice };
      else notices = { ...notices, latest: notice };
      publish(notices);
    },
    dismiss(notice: ConsentNotice) {
      // Object identity guards a removed notice's callback without storing an ID.
      if (notices.first === notice) {
        const latest = notices.latest;
        notices = latest ? (unresolved(latest) ? { first: latest } : { latest }) : {};
      } else if (notices.latest === notice) notices = notices.first ? { first: notices.first } : {};
      else return;
      publish(notices);
    },
  };
}
