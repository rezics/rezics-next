'use client';

import { useActionState } from 'react';
import { Button } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import { createWork, type CreateState } from './actions.ts';
import { CreateWorkReceipt } from './create-work-receipt.tsx';
import type { studio as EnglishStudio } from '../../i18n/en.ts';

const initial: CreateState = { status: 'idle', message: '' };

export function CreateWorkForm({ messages }: { messages: typeof EnglishStudio }) {
  const [state, action, pending] = useActionState(createWork, initial);
  if (state.status === 'created') return <CreateWorkReceipt title={state.title} receipt={state.receipt}
    messages={messages} />;
  return <form className="auth-form" action={action}>
    <div><label htmlFor="title">{messages.workTitle}</label><Input id="title" name="title" maxLength={200} required /></div>
    {state.status !== 'idle' ? <p role={state.status === 'pending' ? 'status' : 'alert'}>{state.message}</p> : null}
    <Button type="submit" disabled={pending}>{pending ? messages.creating : messages.createWork}</Button>
  </form>;
}
