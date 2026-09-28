import { browserMainApi } from '../api/browser.ts';
import { type FollowKind, type Loaded, type MainClient, settle, type SuggestedFollow } from '../feed/types.ts';

// The browser side of the first-minute setup. Every command acts as the
// session's Agent with its own idempotency key; the flow takes a
// `WelcomeApi`, so stories run it against an in-memory Main.

export interface WelcomeApi {
  /** Realms and Zones for the chosen topics and languages, each with its reason. */
  suggestions(input: { concepts: readonly string[]; languages: readonly string[]; locale: string }):
    Promise<Loaded<SuggestedFollow[]>>;
  /** Saves the reader's content languages in their person settings, from the settings' current version. */
  saveLanguages(languages: readonly string[]): Promise<boolean>;
  /** Follows topics and communities in one command: each topic's filter is pinned as a Home tab. */
  follow(targets: readonly { target: string; kind: FollowKind }[]): Promise<boolean>;
}

export function mainWelcomeApi(actingSubject: string, main: MainClient = browserMainApi()): WelcomeApi {
  const key = () => ({ headers: { 'idempotency-key': crypto.randomUUID() } });
  return {
    async suggestions(input) {
      const read = await settle(() => main.v1.onboarding['suggested-follows'].get({ query: { locale: input.locale,
        actingSubject, ...(input.concepts.length ? { concepts: [...input.concepts] } : {}),
        ...(input.languages.length ? { languages: [...input.languages] } : {}) } }));
      return read.ok ? { ok: true, data: read.data.items } : read;
    },
    async saveLanguages(languages) {
      const settings = main.v1.me['person-preferences'];
      const read = await settle(() => settings.get({ query: { actingSubject } }));
      if (!read.ok) return false;
      const { profile: _profile, version, blockedPeople: _blocked, replayed: _replayed, ...choices } = read.data;
      const written = await settle(() => settings.put({ ...choices, contentLanguages: [...languages], actingSubject,
        expectedVersion: version }, key()));
      return written.ok;
    },
    async follow(targets) {
      if (!targets.length) return true;
      const written = await settle(() => main.v1.me.follows.batch.post({ profile: 'follow-batch-v1', actingSubject,
        targets: [...targets] }, key()));
      return written.ok;
    },
  };
}
