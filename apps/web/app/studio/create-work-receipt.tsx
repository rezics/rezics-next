import type { CreateState } from './actions.ts';

type Created = Extract<CreateState, { status: 'created' }>;

export function CreateWorkReceipt({ title, receipt }: Pick<Created, 'title' | 'receipt'>) {
  return <section className="create-receipt" role="status" aria-label="Work created">
    <h2>Work created.</h2>
    <p><strong>{title}</strong> and its Main Version were saved. Keep these IDs for later edits.</p>
    <dl className="detail-list">
      <dt>Work</dt><dd>{receipt.work}</dd>
      <dt>Main Version</dt><dd>{receipt.mainVersion}</dd>
      <dt>Revision</dt><dd>{receipt.workRevision}</dd>
      <dt>Source sequence</dt><dd>{receipt.sourcePosition.sequence}</dd>
    </dl>
  </section>;
}
