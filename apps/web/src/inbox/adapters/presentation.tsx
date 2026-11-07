import { initials } from '../../threads/initials';
import { SignInPrompt } from '../../threads/write-prompts';
import { inboxMediaFailure, inboxThreadHref } from './content';
import type { InboxContentPort } from '../ports/content';

/** Route composition binds Content's public actor identity, thread path and sign-in prompt to Inbox's ports. */
export const inboxContent: InboxContentPort = {
  mediaFailure: inboxMediaFailure,
  initials,
  threadHref: inboxThreadHref,
  SignInPrompt,
};
