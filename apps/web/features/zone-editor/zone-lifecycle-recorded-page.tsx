'use client';

import { Children, cloneElement, isValidElement, useEffect, useState, type ReactNode } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { manager } from '../manage/server.ts';
import { signInPath } from '../auth/paths.ts';
import { messages as manageMessages } from '../manage/messages.ts';
import { RouteLoading } from '../shell/route-states.tsx';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { zoneManagementShell, zonePreviewBody } from '../zones/independent-zone-recorded-page-routes.tsx';
import { messages as zoneMessages } from '../zones/messages.ts';
import { browserZoneLifecycle } from './api.ts';
import { independentZoneFrameModel, independentZoneHomeBody, independentZoneSiteFrame } from '../zones/independent-zone-recorded-page-view.tsx';
import { ZoneHomeContent, ZoneSavedHomeContent } from './home-content.tsx';
import { zoneLifecyclePath } from './routes.ts';
import { readLifecyclePage, readLifecyclePreview, readLifecyclePublic, zoneLifecycleBody } from './zone-lifecycle-recorded-page.ts';

async function renderSaved(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(Children.toArray(node).map(renderSaved));
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  if (node.type === ZoneSavedHomeContent || node.type === ZoneHomeContent) return renderSaved(node.type === ZoneSavedHomeContent
    ? await ZoneSavedHomeContent(node.props as Parameters<typeof ZoneSavedHomeContent>[0])
    : await ZoneHomeContent(node.props as Parameters<typeof ZoneHomeContent>[0]));
  return 'children' in node.props ? cloneElement(node, { children: await renderSaved(node.props.children) }) : node;
}

export function ZoneLifecycleRecordedPage({ record, persona, prefix = 'lifecycle', loading = false, preview = false, publicPage = false, stale = false }: {
  record: AnswerRecord; persona: AnswerPersona; prefix?: string; loading?: boolean; preview?: boolean; publicPage?: boolean; stale?: boolean;
}) {
  const [view, setView] = useState<ReactNode>(null);
  useEffect(() => {
    let active = true;
    if (persona === 'visitor' && !publicPage) {
      const space = new URL(record.personas.visitor.find(s => s.label === 'public-address')!.path, 'https://recorded.invalid').searchParams.get('key')!;
      void manager('en', zoneLifecyclePath(space)).catch((error: unknown) => {
        if (active) setView(<p role="status">{error && typeof error === 'object' && 'digest' in error ? String(error.digest).split(';')[2] : String(error)}</p>);
      });
      return () => { active = false; };
    }
    const samples = record.personas[persona];
    const query = new URL(samples.find(s => s.label === `${prefix}-${publicPage ? 'address' : 'binding-configuration'}`)!.path, 'https://recorded.invalid');
    const space = publicPage ? query.searchParams.get('key')! : query.pathname.split('/')[3]!;
    const actingSubject = publicPage ? (samples.find(s => s.label === `${prefix}-editor`)?.path.split('actingSubject=')[1]
      ? decodeURIComponent(samples.find(s => s.label === `${prefix}-editor`)!.path.split('actingSubject=')[1]!) : '') : query.searchParams.get('actingSubject')!;
    const selections: RecordedSelection[] = samples.filter(s => s.label.startsWith(`${prefix}-`) && s.method === 'GET')
      .map(s => ({ label: s.label, state: loading && s.label === `${prefix}-${publicPage ? 'address' : 'binding-configuration'}` ? 'loading' : s.status >= 400 ? 'error' : 'populated' }));
    const host = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX, sequence: true });
    const commands = recordedFetch(record, persona, samples.filter(s => s.label === (stale ? 'lifecycle-stale' : prefix === 'retired' ? 'lifecycle-recover' : 'lifecycle-retire'))
      .map(s => ({ label: s.label, state: s.status >= 400 ? 'error' : 'populated' })), { pathPrefix: BFF_PREFIX });
    const main = browserMainApi('https://recorded.invalid', { fetcher: host.fetcher });
    if (publicPage) {
      const anonymous = browserMainApi('https://recorded.invalid', { anonymous: true, fetcher: host.fetcher });
      void readLifecyclePublic(anonymous, main, host.fetcher, space, actingSubject || undefined).then(async loaded => {
        if (loaded.kind !== 'published' && loaded.kind !== 'empty') throw new Error(JSON.stringify(loaded));
        const model = independentZoneFrameModel(loaded.presentation, loaded.zone, loaded.zoneId, loaded.ref, 'en', 'Home', 'light');
        const body = await renderSaved(independentZoneHomeBody({ ...loaded, locale: 'en', messages: zoneMessages }));
        if (active) setView(independentZoneSiteFrame(model, undefined, null, body));
      }).catch((error: unknown) => { if (active) setView(<p role="alert">{String(error)}</p>); });
      return () => { active = false; host.dispose(); commands.dispose(); };
    }
    void readLifecyclePage(main, space, 'en', actingSubject).then(async ({ frame, loaded, returnAddress }) => {
      const child = preview ? await renderSaved(await zonePreviewBody(await readLifecyclePreview(main, frame, 'en', actingSubject), {
        locale: 'en', readerTheme: 'light', zoneMessages,
      })) : zoneLifecycleBody(loaded, { locale: 'en', actingSubject, signInHref: signInPath(zoneLifecyclePath(space)), returnAddress,
        api: browserZoneLifecycle(browserMainApi('https://recorded.invalid', { fetcher: commands.fetcher })), onCompleted: () => {} });
      if (active) setView(zoneManagementShell({ space, frame, actingSubject, locale: 'en', manageMessages,
        agent: { iri: actingSubject, label: (samples.find(s => s.label === `${prefix}-agent-profile`)?.answer as { displayName?: string })?.displayName ?? null, handle: null, kind: null, path: null }, children: child }));
    }).catch((error: unknown) => { if (active) setView(<p role="alert">{String(error)}</p>); });
    return () => { active = false; host.dispose(); commands.dispose(); };
  }, [record, persona, prefix, loading, preview, publicPage, stale]);
  return <section aria-label={persona}>{view ?? <RouteLoading />}</section>;
}
