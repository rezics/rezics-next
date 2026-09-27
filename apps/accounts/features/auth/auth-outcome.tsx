'use client';

import { CircleAlertIcon, CircleCheckIcon, MailIcon } from 'lucide-react';
import type { ReactNode } from 'react';

const icons = { mail: MailIcon, done: CircleCheckIcon, problem: CircleAlertIcon };

/** The end of an auth flow: what happened and the one thing to do next. */
export function AuthOutcome({ title, body, action, icon = 'mail' }: { title: string; body: ReactNode;
  action?: ReactNode; icon?: keyof typeof icons }) {
  const Icon = icons[icon];
  return <div role="status" className="flex flex-col gap-4">
    <span className="grid size-12 place-items-center rounded-full bg-accent text-accent-foreground">
      <Icon className="size-6" aria-hidden="true" /></span>
    <h1 className="font-heading text-[28px] leading-tight font-semibold tracking-tight">{title}</h1>
    <p className="text-base text-muted-foreground">{body}</p>
    {action ? <div className="mt-2 flex justify-end">{action}</div> : null}
  </div>;
}
