import { expect, test } from 'bun:test';
import { uiLocales } from '../../i18n/define.ts';
import { communityText } from '../communities/messages.ts';
import { commitAccessEdits, projectedSpaceVisibility, type Participation } from './settings-access.tsx';
import { accessActor, accessInitial, realmAccessInitial } from './settings-fixtures.ts';
import type { RealmSettingsCommand, RealmSettingsReceipt, RealmSettingsView, SettingsCommand, SpaceSettingsView } from './settings-api.ts';

const levels = ['public', 'restricted', 'private'] as const satisfies readonly Participation[];
const helpKey = { public: 'publicHelp', restricted: 'restrictedHelp', private: 'privateHelp' } as const;

const basis: RealmSettingsView = { ...realmAccessInitial, settings: { visibility: 'public', reviewRequired: false,
  reviewMode: 'trusted-members', whoMaySubmit: 'granted', selfJoin: false, rules: realmAccessInitial.settings.rules } };

function spaceAt(visibility: 'public' | 'private'): SpaceSettingsView {
  return { ...accessInitial, settings: { ...accessInitial.settings, visibility } };
}

test('each participation level round-trips through the Realm settings command and projects space visibility', async () => {
  for (const level of levels) {
    const start = level === 'public' ? 'restricted' : 'public';
    const realmWrites: RealmSettingsCommand[] = [];
    const spaceWrites: SettingsCommand[] = [];
    const realm: RealmSettingsView = { ...basis, settings: { ...basis.settings, visibility: start } };
    const result = await commitAccessEdits({
      api: {
        saveRealm: async command => {
          realmWrites.push(command);
          const data: RealmSettingsReceipt = { generation: '13', settings: command.settings,
            receiptId: '00000000-0000-4000-8000-000000000099', replayed: false,
            ruleBasis: { ...realm.ruleBasis, revision: '4' } };
          return { ok: true, data };
        },
        save: async command => { spaceWrites.push(command); return { ok: true, data: spaceAt(command.settings.visibility) }; },
        settings: async () => { throw new Error('a Realm-only write does not re-read'); },
        realm: async () => { throw new Error('a Realm-only write does not re-read'); },
      },
      actingSubject: accessActor, reason: 'Change who can take part', space: spaceAt('public'),
      spaceDraft: spaceAt('public').settings, realm, participation: level,
      keyFor: (_kind, body) => `key:${body.length}`,
    });
    expect(spaceWrites).toEqual([]);
    expect(realmWrites).toHaveLength(1);
    expect(realmWrites[0]!.settings).toEqual({ ...basis.settings, visibility: level });
    expect(realmWrites[0]).toMatchObject({ actingSubject: accessActor, expectedGeneration: realm.generation,
      expectedRulesRevision: realm.ruleBasis.revision, reason: 'Change who can take part' });
    expect(result).toMatchObject({ ok: true, realm: { settings: { visibility: level } },
      space: { generation: '13', settings: { visibility: projectedSpaceVisibility(level) } } });
    expect(projectedSpaceVisibility(level)).toBe(level === 'private' ? 'private' : 'public');
  }
});

test('a stale participation write keeps the Realm command unconfirmed and does not write space settings', async () => {
  const spaceWrites: SettingsCommand[] = [];
  const result = await commitAccessEdits({
    api: {
      saveRealm: async () => ({ ok: false, failure: 'stale' }),
      save: async command => { spaceWrites.push(command); return { ok: true, data: accessInitial }; },
      settings: async () => { throw new Error('a failed participation write does not re-read'); },
      realm: async () => { throw new Error('a failed participation write does not re-read'); },
    },
    actingSubject: accessActor, reason: 'Members only', space: accessInitial,
    spaceDraft: { ...accessInitial.settings, listing: 'unlisted' },
    realm: basis, participation: 'private', keyFor: () => 'stale-key',
  });
  expect(result).toEqual({ ok: false, failure: 'stale', realm: null });
  expect(spaceWrites).toEqual([]);
});

test('discovery edits on a restricted Realm send the public projection and do not rewrite participation', async () => {
  const realm: RealmSettingsView = { ...basis, settings: { ...basis.settings, visibility: 'restricted' } };
  let realmWrites = 0;
  let space: SettingsCommand | null = null;
  const result = await commitAccessEdits({
    api: {
      saveRealm: async () => { realmWrites += 1; return { ok: false, failure: 'unavailable' }; },
      save: async command => { space = command; return { ok: true, data: { ...accessInitial, generation: '13', settings: command.settings } }; },
      settings: async () => ({ ok: true, data: { ...accessInitial, generation: '13',
        settings: { ...accessInitial.settings, listing: 'unlisted', visibility: 'public' } } }),
      realm: async () => ({ ok: true, data: { ...realm, generation: '13', settings: { ...realm.settings, selfJoin: false } } }),
    },
    actingSubject: accessActor, reason: 'Unlist', space: spaceAt('public'),
    spaceDraft: { ...accessInitial.settings, listing: 'unlisted' },
    realm, participation: 'restricted', keyFor: () => 'discovery-key',
  });
  expect(realmWrites).toBe(0);
  expect(space).toMatchObject({ expectedGeneration: '12', settings: { visibility: 'public', listing: 'unlisted',
    history: 'everything', admission: 'request' } });
  expect(result).toMatchObject({ ok: true, realm: { settings: { visibility: 'restricted' } } });
});

test('a participation write and a discovery write share the receipt generation', async () => {
  const seen: Array<{ kind: string; generation: string; visibility: string }> = [];
  await commitAccessEdits({
    api: {
      saveRealm: async command => {
        seen.push({ kind: 'realm', generation: command.expectedGeneration, visibility: command.settings.visibility });
        return { ok: true, data: { generation: '14', settings: command.settings, receiptId: '00000000-0000-4000-8000-000000000099',
          replayed: false, ruleBasis: basis.ruleBasis } };
      },
      save: async command => {
        seen.push({ kind: 'space', generation: command.expectedGeneration, visibility: command.settings.visibility });
        return { ok: true, data: { ...accessInitial, generation: command.expectedGeneration, settings: command.settings } };
      },
      settings: async () => ({ ok: true, data: { ...accessInitial, generation: '15',
        settings: { ...accessInitial.settings, listing: 'unlisted', visibility: 'private' } } }),
      realm: async () => ({ ok: true, data: { ...basis, generation: '15',
        settings: { ...basis.settings, visibility: 'private', selfJoin: false } } }),
    },
    actingSubject: accessActor, reason: 'Private and unlisted', space: accessInitial,
    spaceDraft: { ...accessInitial.settings, listing: 'unlisted' },
    realm: basis, participation: 'private', keyFor: kind => kind,
  });
  expect(seen).toEqual([
    { kind: 'realm', generation: '12', visibility: 'private' },
    { kind: 'space', generation: '14', visibility: 'private' },
  ]);
});

test('unlisting refreshes the shared basis so the next participation save is current and keeps selfJoin', async () => {
  let generation = 12n;
  let storedRealm: RealmSettingsView = { ...basis, generation: '12',
    settings: { ...basis.settings, visibility: 'public', selfJoin: true } };
  let storedSpace: SpaceSettingsView = { ...accessInitial, generation: '12' };
  const realmWrites: RealmSettingsCommand[] = [];
  const api = {
    settings: async () => ({ ok: true as const, data: storedSpace }),
    realm: async () => ({ ok: true as const, data: storedRealm }),
    save: async (command: SettingsCommand) => {
      if (command.expectedGeneration !== storedSpace.generation) return { ok: false as const, failure: 'stale' as const };
      generation += 1n;
      const next = generation.toString();
      const selfJoin = command.settings.admission === 'open';
      storedSpace = { ...storedSpace, generation: next, settings: command.settings };
      storedRealm = { ...storedRealm, generation: next, settings: { ...storedRealm.settings, selfJoin,
        visibility: storedRealm.settings.visibility === 'restricted' && command.settings.visibility === 'public'
          ? 'restricted' : command.settings.visibility } };
      return { ok: true as const, data: storedSpace };
    },
    saveRealm: async (command: RealmSettingsCommand) => {
      realmWrites.push(command);
      if (command.expectedGeneration !== storedRealm.generation) return { ok: false as const, failure: 'stale' as const };
      generation += 1n;
      const next = generation.toString();
      storedRealm = { ...storedRealm, generation: next, settings: command.settings };
      storedSpace = { ...storedSpace, generation: next, settings: { ...storedSpace.settings,
        visibility: projectedSpaceVisibility(command.settings.visibility) } };
      const data: RealmSettingsReceipt = { generation: next, settings: command.settings,
        receiptId: '00000000-0000-4000-8000-000000000099', replayed: false, ruleBasis: storedRealm.ruleBasis };
      return { ok: true as const, data };
    },
  };
  const unlisted = await commitAccessEdits({ api, actingSubject: accessActor, reason: 'Unlist', space: storedSpace,
    spaceDraft: { ...storedSpace.settings, listing: 'unlisted' }, realm: storedRealm, participation: 'public',
    keyFor: () => 'unlist' });
  expect(unlisted.ok).toBe(true);
  if (!unlisted.ok) return;
  expect(unlisted.space.settings.listing).toBe('unlisted');
  expect(unlisted.realm.generation).toBe(unlisted.space.generation);
  expect(unlisted.realm.settings.selfJoin).toBe(false);
  const madePrivate = await commitAccessEdits({ api, actingSubject: accessActor, reason: 'Members only',
    space: unlisted.space, spaceDraft: unlisted.space.settings, realm: unlisted.realm, participation: 'private',
    keyFor: () => 'private' });
  expect(madePrivate).toMatchObject({ ok: true, realm: { settings: { visibility: 'private', selfJoin: false } } });
  expect(realmWrites).toEqual([expect.objectContaining({ expectedGeneration: unlisted.realm.generation,
    settings: expect.objectContaining({ visibility: 'private', selfJoin: false }) })]);
});

test('the create form supplies participation words and help in all eight locales', () => {
  for (const locale of uiLocales) {
    expect(communityText.visibility[locale].trim().length).toBeGreaterThan(0);
    for (const level of levels) {
      expect(communityText[level][locale].trim().length).toBeGreaterThan(0);
      expect(communityText[helpKey[level]][locale].trim().length).toBeGreaterThan(0);
      if (locale !== 'en') {
        expect(communityText[level][locale]).not.toBe(communityText[level].en);
        expect(communityText[helpKey[level]][locale]).not.toBe(communityText[helpKey[level]].en);
      }
    }
  }
});
