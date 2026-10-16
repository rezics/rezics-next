import { browserMainApi } from '../api/browser.ts';
import { addressKey, canonicalHref } from '../address/path.ts';
import { send, type Outcome } from '../manage/commands.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { zoneRealmPath } from '../zone-editor/routes.ts';

type Main = ReturnType<typeof browserMainApi>;
export type RealmSiteCreationIntent = Extract<Parameters<Main['v1']['spaces']['post']>[0], { profile: 'space-zone-v1' }>;
type SpaceAnswer = NonNullable<Awaited<ReturnType<Main['v1']['spaces']['post']>>['data']>;
export type RealmSiteCreationReceipt = Extract<SpaceAnswer, { zone: string }>;
export interface RealmSiteDestination { attachmentPath: string; sitePath: string }

/** Zone creation is one Space command. No Realm is provisioned or reused as its home. */
export function realmSiteCreationClient(main: Main = browserMainApi()) {
  return {
    async create(body: RealmSiteCreationIntent, key: string): Promise<Outcome<RealmSiteCreationReceipt>> {
      const answer = await send(() => main.v1.spaces.post(body, { headers: { 'idempotency-key': key } }), { keepProblem: true });
      if (!answer.ok) return answer;
      const receipt = answer.data;
      if (!('zone' in receipt) || !receipt.zone || !receipt.space || !receipt.zoneRevision
        || !receipt.navigationRevision || receipt.owner !== body.actingSubject
        || receipt.capabilities.length !== 1 || receipt.capabilities[0] !== 'zone') {
        return { ok: false, failure: 'unavailable' };
      }
      return { ok: true, data: receipt };
    },
    prepare(receipt: RealmSiteCreationReceipt, actingSubject: string, key: string) {
      return send(() => main.v1.zones({ id: receipt.zone.slice(-36) }).configuration.put({
        expectedHead: receipt.zoneRevision, prepareHomeDocument: true, actingSubject,
      }, { headers: { 'idempotency-key': key } }), { keepProblem: true });
    },
    async destination(receipt: RealmSiteCreationReceipt, actingSubject: string, locale: UiLocale): Promise<Outcome<RealmSiteDestination>> {
      const answer = await send(() => main.v1.addresses.resolve.get({ query: {
        scope: 'space', key: receipt.space.slice(-36), actingSubject,
      } }), { keepProblem: true });
      if (!answer.ok) return answer;
      const address = answer.data;
      if (address.status !== 'resolved' || address.holder !== receipt.space
        || address.capabilities?.zone !== receipt.zone || address.canonical.prefix !== '/z/') {
        return { ok: false, failure: 'unavailable' };
      }
      return { ok: true, data: { attachmentPath: zoneRealmPath(addressKey(address.canonical)),
        sitePath: canonicalHref(address.canonical, locale) } };
    },
  };
}

export type RealmSiteCreationClient = ReturnType<typeof realmSiteCreationClient>;
