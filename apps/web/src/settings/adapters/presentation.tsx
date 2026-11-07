import { coverSrc } from '../../media/cover-src';
import { initials } from '../../threads/initials';
import { SignInPrompt } from '../../threads/write-prompts';
import { settingsAvatarMedia, settingsMediaFailure, settingsThreadHref } from './content';
import type { SettingsContentPort } from '../ports/content';

/** Route composition binds Content's public media, identity and navigation capabilities to Settings' ports. */
export const settingsContent: SettingsContentPort = {
  avatar: settingsAvatarMedia,
  mediaFailure: settingsMediaFailure,
  coverSrc,
  initials,
  threadHref: settingsThreadHref,
  SignInPrompt,
};
