'use client';

import { useActionState } from 'react';
import { Button } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import { createWork, type CreateState } from './actions.ts';

const initial: CreateState = { message: '' };

export function CreateWorkForm() {
  const [state, action, pending] = useActionState(createWork, initial);
  return <form className="auth-form" action={action}>
    <div><label htmlFor="title">Work title</label><Input id="title" name="title" maxLength={200} required /></div>
    {state.message ? <p role={state.pending ? 'status' : 'alert'}>{state.message}</p> : null}
    <Button type="submit" disabled={pending}>{pending ? 'Creating…' : 'Create Work'}</Button>
  </form>;
}
