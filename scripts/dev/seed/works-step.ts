import { SeedApiError } from './api.ts';
import { grantHomeSeedAuthority, grantImportedWorkSeedAuthority } from './operator.ts';
import { firstSeedTypes, seedKey, semanticTypes, works, type DemoWork } from './plan.ts';
import { demoClassics } from '../../../tests/fixtures/sources/open-library.ts';
import { afterCatchUp, type SeedState, type WorkReceipt } from './state.ts';
import { refreshMetadataBasis } from './metadata.ts';

export async function seedWorks(state: SeedState) {
  const { api, created } = state;
  const owner = state.sessions[0]!;
  const imported = new Set<string>(demoClassics.map(classic => classic.id));
  for (const work of works) {
    if (imported.has(work.id)) continue;
    const session = work.author && work.author !== 'moonlight'
      ? state.sessions.find(candidate => candidate.id === work.author) : owner;
    if (!session) throw new Error(`Work author ${work.author} has no seed session`);
    const author = work.author === 'moonlight' ? state.penAgents.get('moonlight')
      : work.author ? session.actingSubject : undefined;
    if (work.author && !author) throw new Error(`Work author ${work.author} is unavailable`);
    // Mod creation is administrator-only under G-508. Give the fixture author
    // explicit creation authority rather than relying on a member baseline.
    if (work.type === 'mod') {
      if (!state.operatorInput) throw new Error('Mod seed creation requires the local fixture operator');
      await grantImportedWorkSeedAuthority({ ...state.operatorInput,
        ownerAccountSubject: session.accountId, actingSubject: author ?? owner.actingSubject });
    }
    const body = {
      profile: 'metadata-only-v1', title: work.seedTitle ?? work.title, semanticTypes: semanticTypes(work.type),
      language: work.language, actingSubject: author ?? owner.actingSubject,
      ...(author ? { authoring: 'own-work' } : {}) };
    const receipt: WorkReceipt = await api.post<WorkReceipt>('/v1/works', body, session.token, seedKey('work', work.id))
      .catch((error: unknown) => {
        // Stacks seeded before Works named their language and kind recorded these intents without them. Main
        // now requires the language and digests a missing one as English, so the replay states that.
        // A clean `task dev:reset` gives every Work both.
        if (!(error instanceof SeedApiError) || error.status !== 409) throw error;
        return api.post<WorkReceipt>('/v1/works', { ...body, language: 'en', semanticTypes: firstSeedTypes(work.type) },
          session.token, seedKey('work', work.id));
      });
    if (work.seedTitle && state.operatorInput) {
      const actor = author ?? owner.actingSubject;
      const current = await afterCatchUp(() => api.get<{ revision: string; title: { value: string } }>(
        `/v1/works/${receipt.work.slice(-36)}?actingSubject=${encodeURIComponent(actor)}`, session.token));
      if (current.title.value !== work.title) {
        await grantHomeSeedAuthority({ ...state.operatorInput, ownerAccountSubject: session.accountId,
          actingSubject: actor }, [{ action: 'work.edit', scope: `work:edit:${receipt.work}` }]);
        const edited = await api.post<{ revision: string }>('/v1/content-edits', {
          profile: 'metadata-only-v1', work: receipt.work, expectedHead: current.revision,
          title: work.title, actingSubject: actor }, session.token,
        seedKey('clean-work-title-v2', `${work.id}:${current.revision.slice(-12)}`));
        receipt.workRevision = edited.revision;
      } else receipt.workRevision = current.revision;
    }
    created.set(work.id, receipt);
    if (work.tagline) await state.optional('Work serial summary', () => refreshMetadataBasis(async attempt => {
      const path = `/v1/works/${receipt.work.slice(-36)}/metadata`;
      const current = await api.get<{ revision: string | null;
        originalTitle: { value: string; language: string } | null;
        completionStatus: DemoWork['completionStatus'] | null;
        localized: { language: string; title: string | null; description: string | null;
          mainVersionLabel: string | null; tagline?: string | null }[] }>(
        `${path}?actingSubject=${encodeURIComponent(author ?? owner.actingSubject)}`, session.token);
      const previous = current.localized.find(row => row.language.toLowerCase() === work.language.toLowerCase());
      if (previous?.tagline === work.tagline && current.completionStatus === (work.completionStatus ?? null)) return;
      const localized = current.localized.filter(row => row !== previous);
      localized.push({ language: work.language, title: previous?.title ?? null,
        description: previous?.description ?? null, mainVersionLabel: previous?.mainVersionLabel ?? null,
        tagline: work.tagline });
      await api.put(path, { profile: 'work-metadata-details-v1', expectedHead: current.revision,
        state: { kind: 'header', originalTitle: current.originalTitle,
          completionStatus: work.completionStatus ?? current.completionStatus, localized },
        actingSubject: author ?? owner.actingSubject }, session.token,
      seedKey('serial-metadata-v2', `${work.id}:${current.revision?.slice(-12) ?? 'first'}${attempt ? `:${attempt}` : ''}`));
    }));
    if (work.seedTitle && state.operatorInput) {
      await refreshMetadataBasis(async attempt => {
        const path = `/v1/works/${receipt.work.slice(-36)}/metadata`;
        const current = await api.get<{ revision: string | null; originalTitle: { value: string; language: string } | null;
          completionStatus: DemoWork['completionStatus'] | null;
          localized: { language: string; title: string | null; description: string | null;
            mainVersionLabel: string | null; tagline?: string | null }[] }>(
          `${path}?actingSubject=${encodeURIComponent(author ?? owner.actingSubject)}`, session.token);
        if (!current.localized.some(row => row.language.toLowerCase() === work.language.toLowerCase()
          && row.title === work.title)) {
          const localized = current.localized.filter(row => row.language.toLowerCase() !== work.language.toLowerCase());
          const previous = current.localized.find(row => row.language.toLowerCase() === work.language.toLowerCase());
          localized.push({ language: work.language, title: work.title,
            description: previous?.description ?? null, mainVersionLabel: previous?.mainVersionLabel ?? null,
            tagline: previous?.tagline ?? null });
          await api.put(path, { profile: 'work-metadata-details-v1', expectedHead: current.revision,
            state: { kind: 'header', originalTitle: { value: work.title, language: work.language },
              completionStatus: current.completionStatus, localized },
            actingSubject: author ?? owner.actingSubject }, session.token,
          seedKey('clean-title-v2', `${work.id}:${current.revision?.slice(-12) ?? 'first'}${attempt ? `:${attempt}` : ''}`));
        }
      });
    }
    if (work.seedTitle && !state.operatorInput) {
      state.findings?.add(`Work ${work.id} needs the seed operator to replace its old title`);
    }
    console.log(`Work ${created.size}/${works.length}: ${work.title}${receipt.replayed ? ' (replayed)' : ''}`);
  }
}
