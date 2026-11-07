import type { UploadedImage } from '@rezics/ui';
import {
  createMediaReservationIntent,
  readSiteAvatarUploadAdvice,
  resumeReplyImageUpload,
  uploadAvatar,
} from './upload';
import type { MediaReservationIntent, UploadResponseWait, UploadStageUpdate } from './upload-vocabulary';

/** Content's narrow avatar capability for Settings; reply and realm upload transport stays private. */
export const profileAvatarUpload = {
  createIntent(accountId: string, file: File): MediaReservationIntent {
    return createMediaReservationIntent({ containerId: accountId }, file, 'avatar', accountId);
  },
  async upload(
    accountId: string,
    file: File,
    signal: AbortSignal,
    intent?: MediaReservationIntent,
    onStage?: UploadStageUpdate,
    onResponseWait?: UploadResponseWait,
  ): Promise<UploadedImage> {
    return uploadAvatar(accountId, file, signal, intent, onStage, onResponseWait);
  },
  async resume(
    mediaId: string,
    file: File,
    signal: AbortSignal,
    onStage?: UploadStageUpdate,
    intent?: MediaReservationIntent,
    onResponseWait?: UploadResponseWait,
  ): Promise<UploadedImage> {
    return resumeReplyImageUpload(mediaId, file, signal, onStage, intent, onResponseWait);
  },
  readAdvice(signal: AbortSignal, onResponseWait?: UploadResponseWait) {
    return readSiteAvatarUploadAdvice(signal, onResponseWait);
  },
};
