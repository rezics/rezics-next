import { contentMediaFailure } from '../../media/content-failure';
import { profileAvatarUpload } from '../../threads/profile-avatar-upload';
import { threadLocation } from '../../threads/thread-reading-context';
import type { SettingsAvatarMedia, SettingsContentFailureReader } from '../ports/content';

export const settingsMediaFailure: SettingsContentFailureReader = (error) => {
  const failure = contentMediaFailure(error);
  return failure
    ? {
        status: failure.status,
        problem: failure.problem,
        ...(failure.headers === undefined ? {} : { headers: failure.headers }),
      }
    : undefined;
};

export const settingsAvatarMedia: SettingsAvatarMedia = {
  createIntent: (accountId, file) => profileAvatarUpload.createIntent(accountId, file),
  upload: async (accountId, file, signal, intent, onStage, onResponseWait) => {
    const result = await profileAvatarUpload.upload(accountId, file, signal, intent, onStage, onResponseWait);
    return { src: result.src };
  },
  resume: async (mediaId, file, signal, onStage, intent, onResponseWait) => {
    const result = await profileAvatarUpload.resume(mediaId, file, signal, onStage, intent, onResponseWait);
    return { src: result.src };
  },
  readAdvice: (signal, onResponseWait) => profileAvatarUpload.readAdvice(signal, onResponseWait),
};

export const settingsThreadHref = threadLocation;
