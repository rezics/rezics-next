import type { OwnDraftReader } from './model';
import { listOwnDraftPage, resumeOwnDraftPost } from './actions';

/** Private server functions use the authenticated generated client; no browser query cache is involved. */
export const ownDraftNativeReader: OwnDraftReader = Object.freeze({
  list: (data, signal) => listOwnDraftPage({ data, signal }),
  resume: (data, signal) => resumeOwnDraftPost({ data, signal }),
});
