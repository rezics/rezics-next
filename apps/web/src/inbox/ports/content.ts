import type { ComponentType } from 'react';

export type InboxContentFailure = {
  status: number;
  problem: { type: string; title: string; status: number; code: string };
  headers?: HeadersInit;
};
export type InboxContentFailureReader = (error: unknown) => InboxContentFailure | undefined;
export type InboxPromptProps = { returnTo: string; label?: string; compact?: boolean };
export type InboxPrompt = ComponentType<InboxPromptProps>;
export type InboxThreadDestination = {
  id: string;
  title?: string | null;
  postId?: string;
};
export type InboxContentPort = {
  mediaFailure: InboxContentFailureReader;
  initials: (name: string, fallback?: string) => string;
  threadHref: (locale: string, destination: InboxThreadDestination) => string;
  SignInPrompt: InboxPrompt;
};
