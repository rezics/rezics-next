import type { OwnDraftReader } from './model';

/**
 * The installed @rezics/client route type does not yet expose own_drafts.list or own_drafts.resume.
 * Keep the reader seam typed until those generated methods are published; never turn advice into a fetch URL.
 */
export const ownDraftNativeReader: OwnDraftReader = Object.freeze({
  async list() {
    return 'unavailable';
  },
  async resume() {
    return 'unavailable';
  },
});
