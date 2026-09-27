'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Card, CardContent } from '@rezics/ui/card';
import { Input } from '@rezics/ui/input';
import { HourglassIcon, TriangleAlertIcon } from 'lucide-react';
import { useActionState, useId } from 'react';
import { CreateWorkReceipt, type CreatedWork } from './create-work-receipt.tsx';
import type { StudioMessages } from './messages.ts';

export type CreateState =
  | { status: 'idle'; message: '' }
  | { status: 'error'; message: string }
  | { status: 'pending'; message: string; operationId: string }
  | ({ status: 'created' } & CreatedWork);

const initial: CreateState = { status: 'idle', message: '' };

export function CreateWorkForm({ action: create, messages, initialState = initial }: {
  action: (previous: CreateState, form: FormData) => Promise<CreateState>;
  messages: StudioMessages;
  /** Stories start from a given outcome; the page starts idle. */
  initialState?: CreateState;
}) {
  const [state, action, pending] = useActionState(create, initialState);
  const titleId = useId();
  const hintId = useId();
  if (state.status === 'created') {
    return <CreateWorkReceipt title={state.title} receipt={state.receipt} messages={messages} />;
  }
  return <Card>
    <CardContent>
      <form action={action} className="grid gap-5">
        <div className="grid gap-2">
          <label htmlFor={titleId} className="font-medium text-sm">{messages.workTitle}</label>
          <Input id={titleId} name="title" size="lg" maxLength={200} required aria-describedby={hintId}
            aria-invalid={state.status === 'error' || undefined} />
          <p id={hintId} className="text-muted-foreground text-xs">{messages.titleHint}</p>
        </div>
        {state.status === 'error' ? <Alert variant="destructive">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertDescription role="alert" className="text-destructive-foreground">{state.message}</AlertDescription>
        </Alert> : null}
        {state.status === 'pending' ? <Alert variant="info">
          <HourglassIcon aria-hidden="true" />
          <AlertDescription role="status" className="text-foreground">{state.message}</AlertDescription>
        </Alert> : null}
        <div><Button type="submit" size="lg" isLoading={pending} disabled={pending}>
          {pending ? messages.creating : messages.createWork}</Button></div>
      </form>
    </CardContent>
  </Card>;
}
