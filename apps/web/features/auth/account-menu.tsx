'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@rezics/ui/avatar';
import { Menu, MenuContent, MenuGroup, MenuItem, MenuSeparator, MenuTrigger } from '@rezics/ui/menu';
import { useId, useRef } from 'react';
import { agentName, type SessionAgent } from './acting-identity.ts';
import type { AuthMessages } from './messages.ts';
import type { Session } from './session.ts';

function initials(name: string, email: string): string {
  const words = (name || email).trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0]!, words.at(-1)!].map(word => [...word][0]) : [...(words[0] ?? '?')].slice(0, 2);
  return letters.join('').toUpperCase();
}

/** What the menu says about the session Agent. */
export function agentSummary(agent: SessionAgent, messages: AuthMessages): {
  text: string; attention: boolean } {
  switch (agent.status) {
    case 'selected': return { text: agentName(agent.agent, messages), attention: false };
    case 'unselected': return { text: messages.chooseAgent, attention: true };
    case 'ineligible': return { text: messages.agentNotEligible, attention: true };
    case 'none': return { text: messages.noAgent, attention: false };
    case 'unverified': return { text: agent.previous
      ? agentName({ iri: agent.previous, label: null }, messages) : messages.agentUnverified,
    attention: !agent.previous };
  }
}

function AttentionDot() {
  return <span aria-hidden className="size-2 shrink-0 rounded-full bg-warning" />;
}

function currentPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/** The signed-in account and session Agent, with switching and sign-out: the
 * shell's account slot when `readSession()` returns a session (see app/layout.tsx). */
export function AccountMenu({ session, messages }: { session: Session; messages: AuthMessages }) {
  const signOutForm = useRef<HTMLFormElement>(null);
  const returnField = useRef<HTMLInputElement>(null);
  const formId = useId();
  const { user } = session;
  const agent = agentSummary(session.agent, messages);
  const displayName = user.name || user.email;
  return <>
    <Menu onSelect={({ value }) => {
      if (value === 'switch-agent') {
        window.location.assign(`/identity?next=${encodeURIComponent(currentPath())}`);
      } else if (value === 'sign-out' && signOutForm.current && returnField.current) {
        returnField.current.value = currentPath();
        signOutForm.current.requestSubmit();
      }
    }}>
      <MenuTrigger aria-label={messages.accountMenu} className="inline-flex max-w-64 items-center gap-2
        rounded-full p-1 text-start outline-none hover:bg-accent/60 focus-visible:ring-2
        focus-visible:ring-ring sm:pe-3">
        <Avatar size="lg">
          {user.image ? <AvatarImage src={user.image} alt="" /> : null}
          <AvatarFallback className="bg-accent font-semibold text-accent-foreground text-sm">
            {initials(user.name, user.email)}</AvatarFallback>
        </Avatar>
        <span className="hidden min-w-0 flex-col leading-tight sm:flex">
          <span className="truncate font-medium text-sm">{displayName}</span>
          <span className={`flex items-center gap-1 truncate text-xs ${agent.attention
            ? 'text-warning-foreground' : 'text-muted-foreground'}`}>
            {agent.attention ? <AttentionDot /> : null}
            <span className="truncate">{agent.text}</span></span>
        </span>
      </MenuTrigger>
      <MenuContent className="w-72">
        <div className="px-2.5 py-2">
          <p className="truncate font-medium text-sm">{user.name || user.email}</p>
          {user.name && user.email ? <p className="truncate text-muted-foreground text-xs">{user.email}</p> : null}
        </div>
        <MenuSeparator />
        <MenuGroup heading={messages.actingAs}>
          <p className={`flex items-center gap-1.5 px-2.5 pb-1.5 text-sm ${agent.attention
            ? 'text-warning-foreground' : ''}`}>
            {agent.attention ? <AttentionDot /> : null}
            <span className="truncate">{agent.text}</span></p>
          <MenuItem value="switch-agent">{messages.switchAgent}</MenuItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem value="sign-out">{messages.signOut}</MenuItem>
      </MenuContent>
    </Menu>
    <form ref={signOutForm} id={formId} method="post" action="/sign-out" hidden>
      <input ref={returnField} type="hidden" name="next" defaultValue="/" />
    </form>
  </>;
}
