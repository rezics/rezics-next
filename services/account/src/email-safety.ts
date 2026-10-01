import { createHmac, timingSafeEqual } from 'node:crypto';
import { Elysia, t } from 'elysia';
import type { Pool } from 'pg';
import { accountLocale, enqueueAccountEmail, type AccountLocale } from './email.ts';
import { emailLocale } from './account-settings.ts';

const outcomes = [
  'reject',
  'restrict',
  'interim_restrict',
  'final_restrict',
  'dismiss',
  'restore',
  'reverse',
] as const;
type Outcome = (typeof outcomes)[number];
type Correspondence = {
  caseId: string;
  outcome: Outcome;
  credential?: string;
  reasons?: { facts: string; scope: string; duration: string; automation: boolean };
};
/** Constant indexed intake/recipient/queue reads and one encrypted insert. */
export const SAFETY_CORRESPONDENCE_COST = {
  statements: 5,
  messageCharacters: 16_000,
  responseBytes: 1024,
} as const;
const copy: Record<
  AccountLocale,
  {
    case: string;
    credential: string;
    appeal: string;
    automatic: string;
    human: string;
    outcomes: Record<Outcome, string>;
  }
> = {
  en: {
    case: 'Safety case',
    credential: 'Private case credential',
    appeal:
      'Use your case credential in the X-Rezics-Case-Credential header to read the decision or submit an appeal. Keep it private.',
    automatic: 'Automated decision',
    human: 'Decision reviewed by a person',
    outcomes: {
      reject: 'Decision to reject',
      restrict: 'Decision to restrict',
      interim_restrict: 'Decision to restrict temporarily',
      final_restrict: 'Final decision to restrict',
      dismiss: 'Decision to dismiss the report',
      restore: 'Decision to restore',
      reverse: 'Decision to reverse the previous decision',
    },
  },
  'zh-Hans': {
    case: '安全案件',
    credential: '私人案件凭证',
    appeal: '将案件凭证放入 X-Rezics-Case-Credential 请求头，以查看决定或提出申诉。请保密。',
    automatic: '自动决定',
    human: '经人工审核的决定',
    outcomes: {
      reject: '决定：拒绝',
      restrict: '决定：限制',
      interim_restrict: '决定：临时限制',
      final_restrict: '最终决定：限制',
      dismiss: '决定：驳回举报',
      restore: '决定：恢复',
      reverse: '决定：撤销先前决定',
    },
  },
  'zh-Hant': {
    case: '安全案件',
    credential: '私人案件憑證',
    appeal: '將案件憑證放入 X-Rezics-Case-Credential 請求標頭，以查看決定或提出申訴。請保密。',
    automatic: '自動決定',
    human: '經人工審核的決定',
    outcomes: {
      reject: '決定：拒絕',
      restrict: '決定：限制',
      interim_restrict: '決定：暫時限制',
      final_restrict: '最終決定：限制',
      dismiss: '決定：駁回檢舉',
      restore: '決定：恢復',
      reverse: '決定：撤銷先前決定',
    },
  },
  ja: {
    case: '安全案件',
    credential: '非公開の案件認証情報',
    appeal:
      '決定の確認や異議申立てには、X-Rezics-Case-Credential ヘッダーに案件認証情報を指定してください。他人に共有しないでください。',
    automatic: '自動による決定',
    human: '担当者が審査した決定',
    outcomes: {
      reject: '拒否の決定',
      restrict: '制限の決定',
      interim_restrict: '一時的な制限の決定',
      final_restrict: '制限の最終決定',
      dismiss: '報告を却下する決定',
      restore: '復元の決定',
      reverse: '以前の決定を取り消す決定',
    },
  },
  ko: {
    case: '안전 사례',
    credential: '비공개 사례 인증 정보',
    appeal:
      '결정을 확인하거나 이의를 제기하려면 X-Rezics-Case-Credential 헤더에 사례 인증 정보를 넣으세요. 비공개로 보관하세요.',
    automatic: '자동 결정',
    human: '담당자가 검토한 결정',
    outcomes: {
      reject: '거부 결정',
      restrict: '제한 결정',
      interim_restrict: '일시적 제한 결정',
      final_restrict: '최종 제한 결정',
      dismiss: '신고 기각 결정',
      restore: '복원 결정',
      reverse: '이전 결정 취소',
    },
  },
  de: {
    case: 'Sicherheitsfall',
    credential: 'Vertraulicher Fallschlüssel',
    appeal:
      'Verwenden Sie den Fallschlüssel im Header X-Rezics-Case-Credential, um die Entscheidung zu lesen oder Einspruch einzulegen. Halten Sie ihn geheim.',
    automatic: 'Automatisierte Entscheidung',
    human: 'Von einer Person geprüfte Entscheidung',
    outcomes: {
      reject: 'Entscheidung zur Ablehnung',
      restrict: 'Entscheidung zur Einschränkung',
      interim_restrict: 'Entscheidung zur vorläufigen Einschränkung',
      final_restrict: 'Endgültige Entscheidung zur Einschränkung',
      dismiss: 'Entscheidung zur Abweisung der Meldung',
      restore: 'Entscheidung zur Wiederherstellung',
      reverse: 'Entscheidung zur Aufhebung der vorherigen Entscheidung',
    },
  },
  fr: {
    case: 'Dossier de sécurité',
    credential: 'Identifiant confidentiel du dossier',
    appeal:
      'Utilisez votre identifiant dans l’en-tête X-Rezics-Case-Credential pour consulter la décision ou faire appel. Gardez-le confidentiel.',
    automatic: 'Décision automatisée',
    human: 'Décision examinée par une personne',
    outcomes: {
      reject: 'Décision de rejet',
      restrict: 'Décision de restriction',
      interim_restrict: 'Décision de restriction provisoire',
      final_restrict: 'Décision définitive de restriction',
      dismiss: 'Décision de rejet du signalement',
      restore: 'Décision de rétablissement',
      reverse: 'Décision d’annuler la décision précédente',
    },
  },
  es: {
    case: 'Caso de seguridad',
    credential: 'Credencial privada del caso',
    appeal:
      'Use la credencial en la cabecera X-Rezics-Case-Credential para consultar la decisión o presentar una apelación. Manténgala privada.',
    automatic: 'Decisión automatizada',
    human: 'Decisión revisada por una persona',
    outcomes: {
      reject: 'Decisión de rechazo',
      restrict: 'Decisión de restricción',
      interim_restrict: 'Decisión de restricción provisional',
      final_restrict: 'Decisión definitiva de restricción',
      dismiss: 'Decisión de desestimar la denuncia',
      restore: 'Decisión de restauración',
      reverse: 'Decisión de revocar la decisión anterior',
    },
  },
};

export function safetyDecisionMessage(locale: AccountLocale, input: Correspondence): string {
  const text = copy[locale];
  return [
    `${text.case}: ${input.caseId}`,
    text.outcomes[input.outcome],
    ...(input.reasons
      ? [
          input.reasons.facts,
          input.reasons.scope,
          input.reasons.duration,
          input.reasons.automation ? text.automatic : text.human,
        ]
      : []),
    ...(input.credential ? [`${text.credential}: ${input.credential}`] : []),
    text.appeal,
    `GET /v1/public-reports/${input.caseId}`,
    `POST /v1/public-reports/${input.caseId}/correspondence`,
  ].join('\n\n');
}

/** Mandatory private correspondence uses Account's existing notice queue. Only
 * this authenticated intake may create a retained-contact delivery without a user.
 * Credentials stay in encrypted bodies, never in URLs, event keys or logs. */
export function safetyCorrespondenceApi(
  pool: Pool,
  accountSecret: string,
  mainSecret: string,
  accountBaseUrl: string,
) {
  return new Elysia().post(
    '/api/internal/safety-correspondence',
    {
      body: t.Object(
        {
          deliveryId: t.String({ format: 'uuid' }),
          recipient: t.Union([
            t.Object(
              { userId: t.String({ minLength: 1, maxLength: 128 }) },
              { additionalProperties: false },
            ),
            t.Object(
              { contactEmail: t.String({ format: 'email', maxLength: 320 }) },
              { additionalProperties: false },
            ),
          ]),
          caseId: t.String({ format: 'uuid' }),
          outcome: t.Union(outcomes.map((value) => t.Literal(value))),
          contentLanguage: t.String({ minLength: 1, maxLength: 255 }),
          credential: t.Optional(t.String({ pattern: '^[A-Za-z0-9_-]{43}$' })),
          reasons: t.Optional(
            t.Object(
              {
                facts: t.String({ minLength: 1, maxLength: 4000 }),
                scope: t.String({ minLength: 1, maxLength: 4000 }),
                duration: t.String({ minLength: 1, maxLength: 4000 }),
                automation: t.Boolean(),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
      response: {
        200: t.Object({
          state: t.Union(
            ['queued', 'sending', 'sent', 'uncertain', 'expired', 'unavailable'].map((value) =>
              t.Literal(value),
            ),
          ),
          messageId: t.String({ format: 'uuid' }),
        }),
        403: t.Object({ error: t.String() }),
        409: t.Object({ error: t.String() }),
      },
    },
    async ({ request, body: input }) => {
      const bearer = request.headers.get('authorization');
      const received = Buffer.from(bearer?.startsWith('Bearer ') ? bearer.slice(7) : '');
      const expected = Buffer.from(mainSecret);
      if (
        !expected.length ||
        received.length !== expected.length ||
        !timingSafeEqual(received, expected)
      )
        return Response.json({ error: 'forbidden' }, { status: 403 });
      const bytes = createHmac('sha256', accountSecret)
        .update(`safety-correspondence-v1\0${input.deliveryId}`)
        .digest();
      bytes[6] = (bytes[6]! & 0x0f) | 0x50;
      bytes[8] = (bytes[8]! & 0x3f) | 0x80;
      const hex = bytes.subarray(0, 16).toString('hex');
      const messageId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      // Keep Account ownership for its erasure job. Contacts get a keyed digest;
      // no plaintext address or credential enters queue metadata.
      const identity =
        'userId' in input.recipient
          ? input.recipient.userId
          : `safety:${createHmac('sha256', accountSecret).update(input.recipient.contactEmail).digest('hex')}`;
      const read = async () =>
        (
          await pool.query<{ state: string; user_id: string }>(
            'SELECT state,user_id FROM rezics_account_email WHERE id = $1',
            [messageId],
          )
        ).rows[0];
      const previous = await read();
      if (previous)
        return previous.user_id === identity
          ? Response.json({ state: previous.state, messageId })
          : Response.json({ error: 'delivery_conflict' }, { status: 409 });
      let to: string, locale: AccountLocale, userId: string;
      const retainedContact = 'contactEmail' in input.recipient;
      if ('userId' in input.recipient) {
        const user = (
          await pool.query<{
            email: string;
            locale: string | null;
            signup_locale: string | null;
            deletion_started_at: Date | null;
          }>(
            `SELECT u.email,u.locale,u.signup_locale,s.deletion_started_at
        FROM "user" u LEFT JOIN rezics_account_security s ON s.user_id = u.id WHERE u.id = $1`,
            [input.recipient.userId],
          )
        ).rows[0];
        // Suspension and optional suppression cannot disable private safety correspondence.
        if (!user || user.deletion_started_at)
          return Response.json({ state: 'unavailable', messageId });
        to = user.email;
        locale =
          emailLocale(user) ??
          accountLocale(
            new Request('http://locale.local', {
              headers: { 'accept-language': user.signup_locale ?? input.contentLanguage },
            }),
          );
        userId = input.recipient.userId;
      } else {
        to = input.recipient.contactEmail;
        locale = accountLocale(
          new Request('http://locale.local', {
            headers: { 'accept-language': input.contentLanguage },
          }),
        );
        userId = identity;
      }
      await enqueueAccountEmail(
        pool,
        accountSecret,
        {
          userId,
          to,
          locale,
          purpose: 'notice',
          url: accountBaseUrl,
          message: safetyDecisionMessage(locale, input),
          safetyCorrespondence: true,
          ...(retainedContact ? { retainedContact: true } : {}),
        },
        messageId,
      );
      const current = await read();
      return current?.user_id === identity
        ? Response.json({ state: current.state, messageId })
        : Response.json({ error: 'delivery_conflict' }, { status: 409 });
    },
  );
}
