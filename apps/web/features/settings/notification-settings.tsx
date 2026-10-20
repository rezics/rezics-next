'use client';

import { Card, CardContent } from '@rezics/ui/card';
import { Button } from '@rezics/ui/button';
import { Field, FieldHelper, FieldLabel } from '@rezics/ui/field';
import { Switch } from '@rezics/ui/switch';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { SettingsMessages } from './messages.ts';
import { useRecoveryFocus } from './use-recovery-focus.ts';

export const notificationChannels = ['inbox', 'push', 'email'] as const;
type Channel = (typeof notificationChannels)[number];
type NotificationChoice = {
  purpose: 'social' | 'subscription' | 'governance';
  topic: string;
  channel: Channel;
  state: 'enabled' | 'disabled';
  revision: string | null;
};
type ChoiceFeedback = { state: 'saving' | 'saved' | 'failed' | 'conflict' | 'refreshing' | 'refresh-failed';
  checked: boolean };

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
async function readChoices(): Promise<NotificationChoice[]> {
  const response = await fetch('/api/main/v1/me/notification-preferences', { cache: 'no-store' });
  if (!response.ok) throw new Error(String(response.status));
  // This endpoint returns the complete topic/channel matrix, without pagination.
  const preferences = await response.json() as { items: NotificationChoice[] };
  return preferences.items;
}
async function write<T>(body: Record<string, unknown>, bodyKey = false): Promise<T> {
  const key = crypto.randomUUID();
  const response = await fetch('/api/main/v1/me/notification-preferences', {
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
  const [loadState, setLoadState] = useState<'loading' | 'failed' | 'loaded'>(preview ? 'loaded' : 'loading');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const loadRecoveryFocus = useRecoveryFocus<HTMLElement>(loadState === 'loading');
  const [saving, setSaving] = useState('');
  const recoveryFocus = useRecoveryFocus(!!saving);
  const inFlight = useRef(false);
  const feedbackId = useId();
  const [feedback, setFeedback] = useState<Record<string, ChoiceFeedback>>({});
  const feedbackFields = useRef(new Map<string, HTMLDivElement>());
  const activeChoice = useRef('');
  useLayoutEffect(() => {
    const field = feedbackFields.current.get(activeChoice.current);
    if (!field) return;
    const { top, bottom } = field.getBoundingClientRect();
    // New feedback can extend below a visible switch. Reveal its recovery without moving focus,
    // but do not pull someone back after they have scrolled away during the request.
    if (top < window.innerHeight && bottom > 0) {
      field.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    }
  }, [feedback]);
  const forgetSavedReceipts = () => {
    // A refresh may replace an earlier saved value; its receipt no longer describes the displayed version.
    setFeedback(current => Object.fromEntries(Object.entries(current).filter(([, result]) => result.state !== 'saved')));
  };
  useEffect(() => {
    if (preview) return;
    let active = true;
    setLoadState('loading');
    void readChoices()
      .then((value) => {
        if (active) { setChoices(value); setLoadState('loaded'); }
      })
      .catch(() => {
        if (active) setLoadState('failed');
      });
    return () => {
      active = false;
    };
  }, [preview, t, loadAttempt]);
  const save = async (choice: NotificationChoice, checked: boolean) => {
    if (inFlight.current || preview) return;
    inFlight.current = true;
    const key = `${choice.topic}:${choice.channel}`;
    activeChoice.current = key;
    const report = (state: ChoiceFeedback['state']) => setFeedback(current => ({ ...current, [key]: { state, checked } }));
    setSaving(key);
    report('saving');
    try {
      const result = await write<{ state: NotificationChoice['state']; revision: string }>(
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
      report('saved');
    } catch (error) {
      if (String(error).includes('409')) {
        report('refreshing');
        try {
          setChoices(await readChoices());
          forgetSavedReceipts();
          report('conflict');
        } catch { report('refresh-failed'); }
      } else report('failed');
    } finally {
      inFlight.current = false;
      setSaving('');
    }
  };
  const reviewLatest = async (choice: NotificationChoice, checked: boolean) => {
    if (inFlight.current || preview) return;
    recoveryFocus.remember();
    inFlight.current = true;
    const key = `${choice.topic}:${choice.channel}`;
    activeChoice.current = key;
    const report = (state: ChoiceFeedback['state']) => setFeedback(current => ({ ...current, [key]: { state, checked } }));
    setSaving(key); report('refreshing');
    try {
      setChoices(await readChoices()); forgetSavedReceipts(); report('conflict');
    } catch { report('refresh-failed'); }
    finally { inFlight.current = false; setSaving(''); }
  };
  const feedbackText = (state: ChoiceFeedback['state']) => ({
    saving: t.notificationSaving, saved: t.notificationSaved, failed: t.notificationFailed,
    conflict: t.notificationConflict, refreshing: t.notificationRefreshing, 'refresh-failed': t.notificationRefreshFailed,
  })[state];
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
              className="hidden gap-2 border-b pb-2 text-muted-foreground text-xs
        sm:grid sm:grid-cols-[minmax(0,1fr)_6rem_6rem_7rem]"
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
            text-sm last:border-0 sm:grid-cols-[minmax(0,1fr)_6rem_6rem_7rem]"
                >
                  <span className="col-span-3 min-w-0 break-words sm:col-span-1">{label}</span>
                  {notificationChannels.map((channel) => {
                    const choice = choices.find(
                      (item) => item.topic === topic && item.channel === channel,
                    );
                    const key = `${topic}:${channel}`;
                    const result = feedback[key];
                    const channelLabel = channel === 'inbox' ? t.notificationInbox
                      : channel === 'push' ? t.notificationPush : t.notificationEmailDigest;
                    const statusId = `${feedbackId}-${key}`;
                    const retryLabel = result?.state === 'refresh-failed' ? t.reviewLatest
                      : result?.checked ? t.notificationEnable : t.notificationDisable;
                    return (
                      <Field key={channel} ids={{ helperText: statusId }}
                        ref={element => {
                          if (element) feedbackFields.current.set(key, element);
                          else feedbackFields.current.delete(key);
                        }}
                        className="grid min-w-0 content-start justify-items-center gap-2 self-start">
                        <FieldLabel className="sr-only w-px!">{`${label} · ${channelLabel}`}</FieldLabel>
                        <span aria-hidden="true" className="break-words text-center text-muted-foreground text-xs sm:hidden">
                          {channelLabel}</span>
                        <div className="flex justify-center">
                        <Switch
                          ref={topic === choices[0]?.topic && channel === 'inbox' ? element => {
                            loadRecoveryFocus.target.current = element?.querySelector('input') ?? null;
                          } : undefined}
                          size="sm"
                          aria-label={`${label} · ${channelLabel}`}
                          aria-describedby={statusId}
                          checked={choice?.state === 'enabled'}
                          disabled={!choice || !!saving || preview}
                          onCheckedChange={(details) => {
                            if (choice) void save(choice, details.checked);
                          }}
                        />
                        </div>
                        <FieldHelper id={statusId} role={result ? 'status' : undefined} aria-live="polite"
                          aria-atomic="true" className="min-w-0 max-w-full break-words text-center text-xs">
                          {result ? feedbackText(result.state) : ''}
                        </FieldHelper>
                        {choice && result && ['failed', 'conflict', 'refresh-failed'].includes(result.state) ?
                          <Button ref={key === activeChoice.current ? recoveryFocus.target : undefined}
                            type="button" variant="soft" size="sm"
                            className="h-auto min-h-9 max-w-full whitespace-normal px-2 py-1 text-center"
                            disabled={!!saving || preview}
                            aria-label={`${retryLabel} · ${label} · ${channelLabel}`}
                            onClick={() => void (result.state === 'refresh-failed'
                              ? reviewLatest(choice, result.checked) : save(choice, result.checked))}>
                            {retryLabel}
                          </Button> : null}
                      </Field>
                    );
                  })}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="grid justify-items-start gap-3">
            <p id={`${feedbackId}-load`} role="status" aria-live="polite" aria-atomic="true"
              className="text-muted-foreground text-sm">
              {loadState === 'failed' ? t.notificationUnavailable : t.personRefreshing}
            </p>
            {loadState === 'failed' || loadAttempt > 0 ? (
              <Button ref={element => { loadRecoveryFocus.target.current = element; }}
                type="button" variant="soft" className="h-auto min-h-9 max-w-full whitespace-normal"
                isLoading={loadState === 'loading'} aria-describedby={`${feedbackId}-load`}
                onClick={() => {
                  if (loadState === 'loading') return;
                  loadRecoveryFocus.remember();
                  setLoadState('loading');
                  setLoadAttempt(current => current + 1);
                }}>
                {t.reviewLatest}
              </Button>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
