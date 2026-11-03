import { useEffect, useRef } from 'react';
import { m } from '../../paraglide/messages.js';
import type { DocumentSnapshot } from '@rezics/document';
import { InlinePostEditor } from '../composer';
import {
  admittedOwnDraftAction,
  type OwnDraftCommands,
  type OwnDraftEntry,
  type OwnDraftIdentity,
  type OwnDraftSelection,
} from './model';
import type { SavedWriting } from '../local-writing-draft';

export function OwnDraftEditor({
  identity,
  entry,
  selection,
  source,
  browserWriting,
  commands,
  authority,
  current,
  onCancel,
  onAcknowledged,
}: {
  identity: OwnDraftIdentity;
  entry: OwnDraftEntry;
  selection: OwnDraftSelection;
  source: 'server' | 'browser';
  browserWriting: SavedWriting | null;
  commands: OwnDraftCommands;
  authority: object;
  current: () => boolean;
  onCancel: () => void;
  onAcknowledged: (action: 'save' | 'publish') => void;
}) {
  const key = useRef(crypto.randomUUID());
  const controller = useRef<AbortController | null>(null);
  const lastAction = useRef<'save' | 'publish'>('save');
  useEffect(() => () => controller.current?.abort(), []);
  const body = source === 'browser' ? browserWriting?.payload.body : selection.post.body;
  if (!body) return null;
  const mediaIds = source === 'server' ? entry.mediaIds : [];
  const submit =
    (writeAction: 'save' | 'publish') =>
    async ({
      body: next,
      revisionId,
      idempotencyKey,
      mediaIds: nextMedia,
    }: {
      body: DocumentSnapshot;
      revisionId: string;
      idempotencyKey: string;
      mediaIds: string[];
    }) => {
      if (!current()) return { ok: false as const, reason: 'unavailable' as const };
      if (!admittedOwnDraftAction(entry, identity.accountId, writeAction === 'save' ? 'edit' : 'publish'))
        return { ok: false as const, reason: 'forbidden' as const };
      const request = new AbortController();
      controller.current?.abort();
      controller.current = request;
      lastAction.current = writeAction;
      try {
        return await commands.write(
          {
            action: writeAction,
            postId: entry.id,
            threadId: entry.threadId,
            body: next,
            revisionId,
            idempotencyKey,
            mediaIds: nextMedia,
          },
          request.signal,
        );
      } catch {
        return { ok: false as const, reason: 'unavailable' as const };
      }
    };

  return (
    <section aria-label={source === 'server' ? m.own_drafts_server_source() : m.own_drafts_browser_source()}>
      <p className="text-sm text-muted-foreground">
        {source === 'server' ? m.own_drafts_server_source() : m.own_drafts_browser_source()}
      </p>
      <InlinePostEditor
        initialBody={body}
        initialMediaIds={mediaIds}
        ownDraftContext={{
          postId: entry.id,
          threadId: entry.threadId,
          language: entry.language,
          licence: entry.licence,
          subjectIds: entry.subjectIds,
        }}
        inspectionAdmission={{ authority, current }}
        revisionId={selection.revision}
        idempotencyKey={key.current}
        containerId={entry.threadId}
        allowPublish={!!admittedOwnDraftAction(entry, identity.accountId, 'publish')}
        onCancel={onCancel}
        onSubmit={submit('save')}
        onPublish={submit('publish')}
        onSuccess={() => {
          if (!current()) return;
          onAcknowledged(lastAction.current);
        }}
      />
    </section>
  );
}
