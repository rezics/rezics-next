import type { FollowState, RelationshipsApi } from './types.ts';
import { RelationshipError } from './api.ts';

/** Existing page stories supply the older two-field seam. Production controls always use Main's full adapter. */
export function storyFollowApi(base: RelationshipsApi, actions: {
  send: (following: boolean, revision: string | null) => Promise<{ kind: string; following?: boolean; revision?: string }>;
  refresh: () => Promise<{ following: boolean; revision: string | null } | null>;
}, initial: FollowState): RelationshipsApi {
  let state = initial;
  return { ...base,
    async state() {
      const fresh = await actions.refresh();
      if (!fresh) throw new Error('Follow read unavailable');
      state = { ...state, ...fresh };
      return state;
    },
    async set(edit) {
      const result = await actions.send(edit.following, edit.expectedRevision);
      if (result.kind === 'stale') throw new RelationshipError(409);
      if (result.kind !== 'saved' || result.following === undefined || !result.revision) throw new Error('Follow not saved');
      state = { ...state, following: result.following, revision: result.revision,
        level: edit.level ?? state.level, pinPosition: edit.pinPosition === undefined ? state.pinPosition : edit.pinPosition };
      return { target: edit.target, kind: edit.kind ?? 'agent', following: state.following!, revision: state.revision!,
        level: state.level ?? 'highlights', source: state.source ?? 'explicit', pinPosition: state.pinPosition };
    },
  };
}
