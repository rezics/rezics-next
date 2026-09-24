'use client';

import { useActionState } from 'react';
import { Button } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import { createWork, type CreateState } from './actions.ts';

const initial: CreateState = { status: 'idle', message: '' };

export function CreateWorkForm() {
  const [state, action, pending] = useActionState(createWork, initial);
  if (state.status === 'created') return <section className="create-receipt" role="status" aria-label="Work created">
    <h2>{state.message}</h2>
    <p><strong>{state.title}</strong> and its Main Version were saved. Keep these IDs for later edits.</p>
    <dl className="detail-list">
      <dt>Work</dt><dd>{state.receipt.work}</dd>
      <dt>Main Version</dt><dd>{state.receipt.mainVersion}</dd>
      <dt>Revision</dt><dd>{state.receipt.workRevision}</dd>
      <dt>Source sequence</dt><dd>{state.receipt.sourcePosition.sequence}</dd>
    </dl>
  </section>;
  return <form className="auth-form" action={action}>
    <div><label htmlFor="title">Work title</label><Input id="title" name="title" maxLength={200} required /></div>
    {state.status !== 'idle' ? <p role={state.status === 'pending' ? 'status' : 'alert'}>{state.message}</p> : null}
    <Button type="submit" disabled={pending}>{pending ? 'Creating…' : 'Create Work'}</Button>
  </form>;
}
