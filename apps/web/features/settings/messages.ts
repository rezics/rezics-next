import { defineMessages } from '../../i18n/define.ts';
import zhHans from './messages/zh-Hans.ts';


const en = {
  title: 'Profile settings',
  description: 'Your public profile is how people recognize you on REZICS.',
  actingAs: 'Editing',
  publicProfile: 'Public profile',
  displayName: 'Display name',
  avatar: 'Avatar',
  chooseAvatar: 'Choose image',
  noAvatarSelected: 'No image selected',
  bio: 'Bio',
  avatarHelp: 'PNG, JPEG, WebP or GIF, up to 4 MB. The image becomes public when you save.',
  removeAvatar: 'Remove current avatar',
  accountInfo: 'This public name began with your Account name. Changes here do not change your Account name.',
  otherInfo: 'Changes here appear publicly for this Agent.',
  profileUnavailable: 'Profile editing is temporarily unavailable. Try reloading this page.',
  saveProfile: 'Save public profile',
  profileSaved: 'Your public profile was updated.',
  invalid: 'Check the name, bio and image, then try again.',
  avatarDenied: 'An avatar cannot be set for this profile yet. Your edits are still here.',
  avatarUnavailable: 'Avatar service is unavailable. Your edits are still here; try again.',
  handleTitle: 'Handle',
  handleHelp: 'You can change your handle once every 30 days. Your old handle stays linked to the new one for 90 days.',
  save: 'Change handle',
  saved: 'Your handle was changed.',
  cooldown: 'You can change your handle again 30 days after your last change.',
  conflict: 'This profile changed or the handle became unavailable. Reload and try again.',
  denied: 'You can no longer edit this profile. Choose another profile.',
  failed: 'Could not save changes. Try again.',
  choose: 'Choose a profile',
};

export const englishMessages = en;

export const messages = defineMessages({ en, 'zh-Hans': zhHans });

export type SettingsMessages = typeof en;
