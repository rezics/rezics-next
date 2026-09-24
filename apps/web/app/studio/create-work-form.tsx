'use client';

import { useActionState } from 'react';
import { Button } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import { createWork, type CreateState } from './actions.ts';
import { CreateWorkReceipt } from './create-work-receipt.tsx';

const initial: CreateState = { status: 'idle', message: '' };

export function CreateWorkForm() {
  const [state, action, pending] = useActionState(createWork, initial);
  if (state.status === 'created') return <CreateWorkReceipt title={state.title} receipt={state.receipt} />;
  return <form className="auth-form" action={action}>
    <div><label htmlFor="title">Work title</label><Input id="title" name="title" maxLength={200} required /></div>
    {state.status !== 'idle' ? <p role={state.status === 'pending' ? 'status' : 'alert'}>{state.message}</p> : null}
    <Button type="submit" disabled={pending}>{pending ? 'Creating…' : 'Create Work'}</Button>
  </form>;
}
