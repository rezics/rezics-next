import type { CreateState } from './actions.ts';
import type { studio as EnglishStudio } from '../../i18n/en.ts';

type Created = Extract<CreateState, { status: 'created' }>;

export function CreateWorkReceipt({ title, receipt, messages }: Pick<Created, 'title' | 'receipt'> & {
  messages: typeof EnglishStudio }) {
  return <section className="create-receipt" role="status" aria-label={messages.createdStatus}>
    <h2>{messages.createdHeading}</h2>
    <p><strong>{title}</strong>{messages.createdSuffix}</p>
    <dl className="detail-list">
      <dt>{messages.work}</dt><dd>{receipt.work}</dd>
      <dt>{messages.mainVersion}</dt><dd>{receipt.mainVersion}</dd>
      <dt>{messages.revision}</dt><dd>{receipt.workRevision}</dd>
      <dt>{messages.sourceSequence}</dt><dd>{receipt.sourcePosition.sequence}</dd>
    </dl>
  </section>;
}
