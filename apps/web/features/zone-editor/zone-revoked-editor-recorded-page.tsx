'use client';

import { Children, cloneElement, isValidElement, useEffect, useState, type ReactNode } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { manager } from '../manage/server.ts';
import { messages as manageMessages } from '../manage/messages.ts';
import { RouteLoading } from '../shell/route-states.tsx';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { zoneHomeView, zoneManagementShell, zonePreviewBody } from '../zones/independent-zone-recorded-page-routes.tsx';
import { independentZoneFrameModel, independentZoneHomeBody, independentZoneSiteFrame } from '../zones/independent-zone-recorded-page-view.tsx';
import { messages as zoneMessages } from '../zones/messages.ts';
import { browserZoneAuthoring } from './api.ts';
import { zoneEditorDraftKey } from './draft-state.ts';
import { ZoneHomeContent, ZoneSavedHomeContent } from './home-content.tsx';
import { ZoneEditSiteLink } from './edit-site-link.tsx';
import { zoneEditorPath } from './routes.ts';
import { readRevokedEditor, readRevokedPreview, readRevokedPublic } from './zone-revoked-editor-recorded-page.ts';

/** Resolve the installed async home components before mounting the server page in Storybook. */
async function renderHome(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(Children.toArray(node).map(renderHome));
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  if (node.type === ZoneHomeContent) return renderHome(await ZoneHomeContent(node.props as Parameters<typeof ZoneHomeContent>[0]));
  if (node.type === ZoneSavedHomeContent) return renderHome(await ZoneSavedHomeContent(node.props as Parameters<typeof ZoneSavedHomeContent>[0]));
  return 'children' in node.props ? cloneElement(node, { children: await renderHome(node.props.children) }) : node;
}

export function ZoneRevokedEditorRecordedPage({ record, persona, prefix = 'restored', view = 'editor', loading = false, stale = false }: {
  record: AnswerRecord; persona: AnswerPersona; prefix?: string; view?: 'editor' | 'preview' | 'public'; loading?: boolean; stale?: boolean;
}) {
  const [page, setPage] = useState<ReactNode>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    const samples = record.personas[persona];
    if (persona === 'visitor' && view !== 'public') {
      const space = new URL(samples.find(s => s.label === 'public-site-address')!.path, 'https://recorded.invalid').searchParams.get('key')!;
      void manager('en', zoneEditorPath(space)).catch((reason: unknown) => {
        if (active) setPage(<p role="status">{reason && typeof reason === 'object' && 'digest' in reason ? String(reason.digest).split(';')[2] : String(reason)}</p>);
      });
      return () => { active = false; };
    }
    const publicPage = view === 'public';
    const selected = samples.filter(s => publicPage
      ? prefix === 'public' ? s.label.startsWith('public-') : ['address', 'presentation', 'route', 'personal-presentation', 'editor'].some(part => s.label === `${prefix}-${part}`)
      : ['configuration', 'configuration-1', 'address', 'editor', 'zone', 'zone-1'].some(part => s.label === `${prefix}-${part}`));
    const entry = selected.find(s => s.label.endsWith(publicPage ? '-address' : '-configuration'))!;
    const query = new URL(entry.path, 'https://recorded.invalid');
    const space = publicPage ? query.searchParams.get('key')! : query.pathname.split('/')[3]!;
    const acting = publicPage ? new URL(selected.find(s => s.path.includes('actingSubject='))?.path ?? '/', query).searchParams.get('actingSubject') ?? undefined
      : query.searchParams.get('actingSubject')!;
    const replay = recordedFetch(record, persona, [...selected, ...(stale ? samples.filter(s => s.label === 'stale-publication') : [])].map(s => ({
      label: s.label, state: loading && s === entry ? 'loading' : s.status >= 400 ? 'error' : 'populated',
    })), { pathPrefix: BFF_PREFIX, sequence: true });
    const main = browserMainApi('https://recorded.invalid', { fetcher: replay.fetcher });
    async function load() {
      if (publicPage) {
        const anonymous = browserMainApi('https://recorded.invalid', { anonymous: true, fetcher: replay.fetcher });
        const loaded = await readRevokedPublic(anonymous, main, space, acting);
        if (loaded.kind !== 'published') throw new Error(`Recorded home is ${loaded.kind}`);
        const model = independentZoneFrameModel(loaded.presentation, loaded.zone, loaded.zoneId, loaded.ref, 'en', 'Home', 'light');
        return independentZoneSiteFrame(model, undefined, loaded.editor?.ok
          ? <ZoneEditSiteLink space={loaded.ref}>{manageMessages.editSite}</ZoneEditSiteLink> : null,
        await renderHome(independentZoneHomeBody({ ...loaded, locale: 'en', messages: zoneMessages })));
      }
      sessionStorage.removeItem(zoneEditorDraftKey(space, acting!, 'home'));
      const frame = await readRevokedEditor(main, space, acting!);
      const child = view === 'preview' ? await renderHome(await zonePreviewBody(await readRevokedPreview(main, frame, acting!), {
        locale: 'en', readerTheme: 'light', zoneMessages,
      })) : await zoneHomeView({ space, locale: 'en', actingSubject: acting!, signInHref: '/auth/start',
        loadLifecycle: async () => frame.lifecycle, loadAuthoring: async () => frame.authoring, api: browserZoneAuthoring(main) });
      return zoneManagementShell({ space, frame, actingSubject: acting!, locale: 'en', manageMessages,
        agent: { iri: acting!, label: null, handle: null, kind: null, path: null }, children: child });
    }
    void load().then(next => { if (active) setPage(next); }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason : new Error(String(reason)));
    });
    return () => { active = false; replay.dispose(); };
  }, [record, persona, prefix, view, loading, stale]);
  if (error) throw error;
  return page ?? <RouteLoading />;
}
