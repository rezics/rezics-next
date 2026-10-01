import { expect, spyOn, test } from 'bun:test';
import type { Pool } from 'pg';
import { NotificationProducer } from '../src/modules/notification-producers/producer.ts';
import { notificationProducerSubjectReader } from '../src/modules/notification-producers/subjects.ts';
import { safetyDecisionMessage } from '../../account/src/email-safety.ts';
import type { AccountLocale } from '../../account/src/email.ts';
import type { NotificationEvent } from '../src/modules/notification/store.ts';
import {
  SafetyDecisionMail,
  SAFETY_NOTICE_MAIL_COST,
  type SafetyNoticeMail,
} from '../src/modules/governance/notices-mail.ts';

const recipient = '00000000-0000-4000-8000-000000000001';
const decision = '00000000-0000-4000-8000-000000000002';
const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';

test('SAFETY07 G918: recorded Content notice owners receive moderation notifications without graph authors', async () => {
  const events: NotificationEvent[] = [];
  let advanced = false,
    queued = false;
  const client = {
    query: async (sql: string) => {
      if (sql.includes('FROM access.recovery_fence')) return { rows: [{ open: true }] };
      if (sql.includes('FROM access.notification_producer_cursor'))
        return { rows: [{ position: '0' }] };
      if (sql.includes('FROM access.notification_producer_event'))
        return { rows: [{ position: '1', kind: 'moderation_outcome', event_id: decision }] };
      if (sql.includes('UPDATE access.notification_producer_cursor')) advanced = true;
      return { rows: [] };
    },
    release: () => {},
  };
  const access = {
    connect: async () => client,
    query: async (sql: string) => {
      if (sql.includes('FROM access.moderation_decision'))
        return {
          rows: [
            {
              case_id: decision,
              principal_id: recipient,
              acting_subject: actor,
              context: 'urn:rezics:context:global',
              target_resource: actor,
              statement_of_reasons: {},
            },
          ],
        };
      if (sql.includes('FROM access.governance_report')) return { rows: [] };
      if (sql.includes('FROM access.safety_party_notice')) return { rows: [{ id: recipient }] };
      throw new Error('Unexpected owner query');
    },
  } as unknown as Pool;
  const producer = new NotificationProducer(
    access,
    null,
    {} as Pool,
    {
      query: async () => {
        throw new Error('A safety notice must not depend on public graph visibility');
      },
    },
    {
      enqueue: async (event) => {
        events.push(event);
        return [];
      },
    },
    null,
  );
  producer.setSafetyCorrespondence({
    enqueueDecision: async () => {
      queued = true;
      throw new Error('intake lost');
    },
  });
  await expect(producer.runSafetyCorrespondenceOnce()).rejects.toThrow('intake lost');
  expect(queued).toBe(true);
  expect(advanced).toBe(false);
  expect(events).toHaveLength(0);
  producer.setSafetyCorrespondence({ enqueueDecision: async () => {} });
  expect(await producer.runAccessOnce()).toBe(2);
  expect(events).toMatchObject([
    { sourceEvent: `moderation:${decision}`, purpose: 'governance', recipients: [recipient] },
  ]);
  expect(advanced).toBe(true);
});

test('SAFETY07 G918: generic delivery rechecks the exact private notice without exposing its credential', async () => {
  let affected = true;
  const access = {
    query: async () => ({
      rows: [
        {
          case_id: decision,
          target_resource: 'urn:content:removed',
          context: 'urn:rezics:context:global',
          outcome: 'restrict',
          reporter: false,
          affected,
          safety: true,
        },
      ],
    }),
  } as unknown as Pool;
  const reader = notificationProducerSubjectReader(access, {} as Pool, {} as never);
  const input = {
    principalId: recipient,
    owner: 'access',
    ref: decision,
    revision: null,
    disclosureBasis: 'moderation-outcome-v1',
  };
  expect(await reader.resolve(input)).toEqual({
    status: 'available',
    subject: { private: true, fields: { linkTarget: 'urn:content:removed', excerpt: 'restrict' } },
  });
  affected = false;
  expect(await reader.resolve(input)).toEqual({ status: 'undisclosed' });
});

test('SAFETY07 G918: all mail locales explain decisions and private header credentials without secret URLs', () => {
  const credential = 'a'.repeat(43);
  for (const locale of [
    'en',
    'zh-Hans',
    'zh-Hant',
    'ja',
    'ko',
    'de',
    'fr',
    'es',
  ] as AccountLocale[]) {
    const messages = [
      'reject',
      'restrict',
      'interim_restrict',
      'final_restrict',
      'dismiss',
      'restore',
      'reverse',
    ].map((outcome) =>
      safetyDecisionMessage(locale, {
        caseId: decision,
        outcome: outcome as 'restrict',
        credential,
        reasons: {
          facts: 'Owner facts',
          scope: 'One image',
          duration: 'Until review',
          automation: false,
        },
      }),
    );
    expect(new Set(messages).size).toBe(7);
    for (const message of messages) {
      expect(message).toContain(credential);
      expect(message).toContain('X-Rezics-Case-Credential');
      expect(message).toContain('Owner facts');
      for (const line of message.split('\n'))
        if (line.startsWith('GET ') || line.startsWith('POST '))
          expect(line).not.toContain(credential);
    }
    const reporter = safetyDecisionMessage(locale, { caseId: decision, outcome: 'restrict' });
    expect(reporter).not.toContain(credential);
    expect(reporter).not.toContain('Owner facts');
  }
});

test('SAFETY07 G918: private correspondence pages past 256 parties and reports without losing timestamp precision', async () => {
  const mails: SafetyNoticeMail[] = [];
  const parties = Array.from({ length: SAFETY_NOTICE_MAIL_COST.page + 1 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    principal_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    credential: 'a'.repeat(43),
    account_subject: `account-${i}`,
  }));
  const reports = parties.map((party) => ({
    id: party.id,
    received_at: '2026-10-01 00:00:00.123456+00',
    contact_email: `${party.account_subject}@example.test`,
    account_subject: null,
    content_language: 'en',
  }));
  const client = {
    query: async (sql: string, args?: unknown[]) => {
      if (sql.includes('FROM access.recovery_fence')) return { rows: [{ open: true }] };
      if (sql.includes('FROM access.moderation_decision'))
        return {
          rows: [
            {
              case_id: decision,
              outcome: 'restrict',
              disclosure: 'private',
              statement_of_reasons: {
                facts: 'Private owner reasons',
                scope: 'One grain',
                duration: 'Until review',
                automation: false,
                contentLanguage: 'en',
              },
            },
          ],
        };
      if (sql.includes('SELECT n.id')) {
        expect(args?.[3]).toBe(SAFETY_NOTICE_MAIL_COST.page);
        return {
          rows: args?.[2]
            ? parties.slice(SAFETY_NOTICE_MAIL_COST.page)
            : parties.slice(0, SAFETY_NOTICE_MAIL_COST.page),
        };
      }
      if (sql.includes('SELECT r.id')) {
        expect(args?.[5]).toBe(SAFETY_NOTICE_MAIL_COST.page);
        if (args?.[2]) expect(args[2]).toBe('2026-10-01 00:00:00.123456+00');
        return {
          rows: args?.[2]
            ? reports.slice(SAFETY_NOTICE_MAIL_COST.page)
            : reports.slice(0, SAFETY_NOTICE_MAIL_COST.page),
        };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  await new SafetyDecisionMail(
    { connect: async () => client } as unknown as Pool,
    'issuer',
    async (mail) => {
      mails.push(mail);
    },
  ).enqueueDecision(decision);
  expect(mails).toHaveLength(514);
  expect(new Set(mails.map((mail) => mail.deliveryId)).size).toBe(514);
  expect(
    mails
      .filter((mail) => 'userId' in mail.recipient)
      .every((mail) => mail.reasons?.facts === 'Private owner reasons'),
  ).toBe(true);
  expect(
    mails
      .filter((mail) => 'contactEmail' in mail.recipient)
      .every((mail) => mail.reasons === undefined && mail.credential === undefined),
  ).toBe(true);
});

test('SAFETY07 G918: correspondence outage leaves editorial, responder alerts and relay running and logs no private transport error', async () => {
  const logged = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const calls: string[] = [];
    const client = {
      query: async (sql: string) => ({
        rows: sql.includes('recovery_fence') ? [{ open: true }] : [],
      }),
      release: () => {},
    };
    class Producer extends NotificationProducer {
      override async runEditorialOnce() {
        calls.push('editorial');
        return 3;
      }
      override async runSafetyCorrespondenceOnce(): Promise<number> {
        throw new Error('private credential must not be logged');
      }
      override async runRelayOnce() {
        calls.push('relay');
        return 0;
      }
    }
    const producer = new Producer(
      { connect: async () => client } as unknown as Pool,
      null,
      {} as Pool,
      {} as never,
      {} as never,
      null,
      null,
      {
        runOnce: async () => {
          calls.push('alerts');
          return 1;
        },
      },
    );
    expect(await producer.runAccessOnce()).toBe(4);
    await producer.runRelayOnce();
    expect(calls).toEqual(['editorial', 'alerts', 'relay']);
    expect(logged).toHaveBeenCalledWith('Safety correspondence intake unavailable');
  } finally {
    logged.mockRestore();
  }
});
