'use client';

import { Card, CardContent } from '@rezics/ui/card';
import { Switch } from '@rezics/ui/switch';
import { useEffect, useState } from 'react';
import { BFF_PREFIX } from '../api/browser.ts';
import type { SettingsMessages } from './messages.ts';

export const notificationChannels = ['inbox', 'push', 'email'] as const;
type Channel = (typeof notificationChannels)[number];
type NotificationChoice = {
  purpose: 'social' | 'subscription' | 'governance';
  topic: string;
  channel: Channel;
  state: 'enabled' | 'disabled';
  revision: string | null;
};

/** Topics with an active producer, in the preferences API's order. A label is required for each. */
export const settingsNotificationTopics = [
  'reply',
  'mention',
  'post-vote',
  'followed-chapter',
  'new-work',
  'new-release',
  'collection-change',
  'review-helpful',
  'review',
  'review-requested',
  'changes-requested',
  'proposal-revised',
  'proposal-decided',
  'proposal-withdrawn',
  'proposal-reverted',
] as const;
type SettingsNotificationTopic = (typeof settingsNotificationTopics)[number];
export const notificationTopicLabel: Record<SettingsNotificationTopic, keyof SettingsMessages> = {
  reply: 'notificationReply',
  mention: 'notificationMention',
  'post-vote': 'notificationPostVote',
  'followed-chapter': 'notificationFollowedChapter',
  'new-work': 'notificationNewWork',
  'new-release': 'notificationNewRelease',
  'collection-change': 'notificationCollectionChange',
  'review-helpful': 'notificationReviewHelpful',
  review: 'notificationReview',
  'review-requested': 'notificationReviewRequested',
  'changes-requested': 'notificationChangesRequested',
  'proposal-revised': 'notificationProposalRevised',
  'proposal-decided': 'notificationProposalDecided',
  'proposal-withdrawn': 'notificationProposalWithdrawn',
  'proposal-reverted': 'notificationProposalReverted',
};

/** What the settings list shows: each topic the preferences response contains, once, in that order. */
export function topicsShown(items: readonly { topic: string }[]): string[] {
  const seen = new Set<string>();
  const topics: string[] = [];
  for (const item of items) {
    if (seen.has(item.topic)) continue;
    seen.add(item.topic);
    topics.push(item.topic);
  }
  return topics;
}

const governanceTopics = new Set<string>([
  'review-requested',
  'changes-requested',
  'proposal-revised',
  'proposal-decided',
  'proposal-withdrawn',
  'proposal-reverted',
]);
function purposeOf(topic: string): NotificationChoice['purpose'] {
  if (
    topic === 'followed-chapter' ||
    topic === 'new-work' ||
    topic === 'new-release' ||
    topic === 'collection-change'
  )
    return 'subscription';
  return governanceTopics.has(topic) ? 'governance' : 'social';
}
function labelFor(topic: string, t: SettingsMessages): string {
  return (settingsNotificationTopics as readonly string[]).includes(topic)
    ? t[notificationTopicLabel[topic as SettingsNotificationTopic]]
    : topic;
}
async function read<T>(path: string): Promise<T> {
  const response = await fetch(`${BFF_PREFIX}${path}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(String(response.status));
  return response.json() as Promise<T>;
}
async function write<T>(path: string, body: Record<string, unknown>, bodyKey = false): Promise<T> {
  const key = crypto.randomUUID();
  const response = await fetch(`${BFF_PREFIX}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(bodyKey ? { ...body, idempotencyKey: key } : body),
  });
  if (!response.ok) throw new Error(String(response.status));
  return response.json() as Promise<T>;
}

export function NotificationSettings({
  t,
  preview = false,
}: {
  t: SettingsMessages;
  preview?: boolean;
}) {
  const [choices, setChoices] = useState<NotificationChoice[] | null>(
    preview
      ? settingsNotificationTopics.flatMap((topic) =>
          notificationChannels.map((channel) => ({
            purpose: purposeOf(topic),
            topic,
            channel,
            state: channel === 'email' ? ('disabled' as const) : ('enabled' as const),
            revision: null,
          })),
        )
      : null,
  );
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState('');
  useEffect(() => {
    if (preview) return;
    let active = true;
    void read<{ items: NotificationChoice[] }>('/v1/me/notification-preferences')
      .then((value) => {
        if (active) setChoices(value.items);
      })
      .catch(() => {
        if (active) setStatus(t.notificationUnavailable);
      });
    return () => {
      active = false;
    };
  }, [preview, t]);
  const save = async (choice: NotificationChoice, checked: boolean) => {
    const key = `${choice.topic}:${choice.channel}`;
    setSaving(key);
    setStatus('');
    try {
      const result = await write<{ state: NotificationChoice['state']; revision: string }>(
        '/v1/me/notification-preferences',
        {
          profile: 'notification-preference-v1',
          purpose: choice.purpose,
          topic: choice.topic,
          channel: choice.channel,
          state: checked ? 'enabled' : 'disabled',
          expectedRevision: choice.revision,
        },
        true,
      );
      setChoices(
        (current) =>
          current?.map((item) =>
            item.topic === choice.topic && item.channel === choice.channel
              ? { ...item, state: result.state, revision: result.revision }
              : item,
          ) ?? null,
      );
      setStatus(t.notificationSaved);
    } catch (error) {
      setStatus(String(error).includes('409') ? t.sectionStale : t.sectionFailed);
    }
    setSaving('');
  };
  return (
    <Card id="notifications">
      <CardContent className="grid gap-5 p-5 sm:p-6">
        <div className="grid gap-1">
          <h2 className="font-semibold text-xl">{t.notificationsTitle}</h2>
          <p className="text-muted-foreground text-sm">{t.notificationsHelp}</p>
        </div>
        {choices ? (
          <div className="grid gap-0">
            <div
              className="grid grid-cols-3 gap-2 border-b pb-2 text-muted-foreground text-xs
        sm:grid-cols-[minmax(0,1fr)_4rem_4rem_6rem]"
            >
              <span className="hidden sm:block">{t.notificationType}</span>
              <span className="text-center">{t.notificationInbox}</span>
              <span className="text-center">{t.notificationPush}</span>
              <span className="text-center">{t.notificationEmailDigest}</span>
            </div>
            {topicsShown(choices).map((topic) => {
              const label = labelFor(topic, t);
              return (
                <div
                  key={topic}
                  className="grid min-h-12 grid-cols-3 items-center gap-2 border-b border-border/50 py-2
            text-sm last:border-0 sm:grid-cols-[minmax(0,1fr)_4rem_4rem_6rem]"
                >
                  <span className="col-span-3 min-w-0 break-words sm:col-span-1">{label}</span>
                  {notificationChannels.map((channel) => {
                    const choice = choices.find(
                      (item) => item.topic === topic && item.channel === channel,
                    );
                    return (
                      <span key={channel} className="flex justify-center">
                        <Switch
                          size="sm"
                          aria-label={`${label} · ${channel === 'inbox' ? t.notificationInbox : channel === 'push' ? t.notificationPush : t.notificationEmailDigest}`}
                          checked={choice?.state === 'enabled'}
                          disabled={!choice || !!saving || preview}
                          onCheckedChange={(details) => {
                            if (choice) void save(choice, details.checked);
                          }}
                        />
                      </span>
                    );
                  })}
                </div>
              );
            })}
          </div>
        ) : (
          <p role="status" className="text-muted-foreground text-sm">
            {status || '…'}
          </p>
        )}
        {choices && status ? (
          <p role="status" className="text-sm">
            {status}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
