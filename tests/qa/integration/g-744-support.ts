import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import {
  GovernanceStore,
  type DecisionInput,
  type DecisionResult,
} from '../../../services/main/src/modules/governance/store.ts';
import { GovernanceRules } from '../../../services/main/src/modules/governance/rules.ts';
import {
  ownerEvidenceCapture,
  ownerTargetHeads,
} from '../../../services/main/src/modules/governance/evidence.ts';
import { ownerModerationEffects } from '../../../services/main/src/modules/governance/effects.ts';
import { ContentModeration } from '../../../services/content/src/moderation.ts';
import { PublicReports } from '../../../services/main/src/modules/public-report/store.ts';
import { publicReportOwners } from '../../../services/main/src/modules/public-report/owners.ts';
import { NotificationStore } from '../../../services/main/src/modules/notification/store.ts';
import { NotificationProducer } from '../../../services/main/src/modules/notification-producers/producer.ts';
import { SafetyAlerts, SAFETY_ALERT_BASIS } from '../../../services/main/src/modules/safety-alerts/store.ts';
import { startMediaStack, png, sha, type MediaStack } from './media-support.ts';
import { fixtureReasons } from './g-565-decision-support.ts';

export { png, sha };
export type Receipt = { caseId: string; reportId: string; credential: string; receivedAt: string };
type Member = Awaited<ReturnType<MediaStack['member']>>;
export type Image = Awaited<ReturnType<Member['upload']>>;
export const nciiDeclaration = {
  contactEmail: 'depicted@example.test',
  ncii: {
    signature: 'Depicted person',
    depictedPersonOrAuthorized: true,
    goodFaithWithoutConsent: true,
    supportingInformation: 'The publication was without consent.',
  },
};

export async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  expect(response.status, text).toBe(status);
  return JSON.parse(text) as T;
}

/** The established G-565 fixture: real Access, Content, graph and object owners.
 * Bearer mapping isolates staff authority; SAFETY01 separately uses real Account introspection.
 * No alert, mail or scanning result is manufactured by this fixture. */
export async function safetyFixture(label: string, autoClearUploads = true,
  ownerUrls?: { access: string; content: string; relay: string }) {
  const stack = await startMediaStack(label, { autoClearUploads, ownerUrls });
  try {
    const staff = await stack.member('primary-responder');
    const backup = await stack.member('backup-responder');
    const author = await stack.member('affected-uploader');
    for (const member of [staff, backup])
      for (const action of [
        'governance.moderate',
        'governance.rights.decide',
        'governance.rule.publish',
        'governance.safety.evidence',
      ])
        await member.grant('governance:platform', action);
    let clock = new Date();
    const rules = new GovernanceRules(stack.accessPool);
    const governance = new GovernanceStore(
      stack.accessPool,
      ownerEvidenceCapture({
        content: {
          core: stack.content,
          canRead: async (_principal, _actor, ids) => {
            const rows = await stack.contentPool.query<{ id: string }>(
              `SELECT r.id FROM content.revision r
          JOIN content.variant v ON v.id = r.variant_id JOIN media.asset a ON a.variant_id = v.id
          JOIN media.asset_state s ON s.id = a.state_head WHERE r.id = ANY($1::uuid[])
            AND s.disclosure = 'public' AND s.lifecycle = 'active' AND s.moderation = 'none'`,
              [ids],
            );
            return new Set(rows.rows.map((row) => row.id));
          },
        },
      }),
      ownerTargetHeads({ graph: stack.env, content: stack.contentPool }),
      rules,
      ownerModerationEffects(new ContentModeration(stack.contentPool), stack.env, {
        pool: stack.contentPool,
        core: stack.content,
      }),
      undefined,
      () => clock,
    );
    const tokens = new Map<string, typeof staff.principal>(
      [staff, backup, author].map((member) => [member.token, member.principal]),
    );
    const notifications = new NotificationStore(stack.accessPool);
    const safetyAlerts = new SafetyAlerts(stack.accessPool, notifications, {
      issuer: staff.principal.issuer, primary: staff.principal.subject, backup: backup.principal.subject,
    }, () => clock);
    await safetyAlerts.initialize();
    notifications.registerReadSubjectReader(SAFETY_ALERT_BASIS, safetyAlerts);
    const producer = new NotificationProducer(
      stack.accessPool,
      null,
      stack.contentPool,
      stack.fuseki,
      notifications,
      null,
      null,
      safetyAlerts,
    );
    const deps: MainWorkDependencies = {
      environment: stack.env,
      access: stack.access,
      content: stack.content,
      contentAuthoring: stack.content,
      media: stack.media,
      mediaAccess: stack.mediaAccess,
      governance: { store: governance, rules },
      account: {
        verify: async (request) => {
          const principal = tokens.get(
            request.headers.get('authorization')?.replace('Bearer ', '') ?? '',
          );
          if (!principal) throw new AccountAssertionDenied('Unknown fixture bearer');
          return principal;
        },
      },
    };
    deps.publicReports = new PublicReports(
      stack.accessPool,
      publicReportOwners(deps, stack.contentPool, stack.content),
    );
    const app = createMainApp(stack.fuseki, deps);
    const call = (
      method: string,
      path: string,
      body?: unknown,
      token?: string,
      key: string = randomUUID(),
      credential?: string,
    ) =>
      app.handle(
        new Request(`http://main.local${path}`, {
          method,
          headers: {
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(credential ? { 'x-rezics-case-credential': credential } : {}),
            ...(method === 'POST' ? { 'idempotency-key': key } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    const read = (path: string, member = staff) =>
      call(
        'GET',
        `${path}${path.includes('?') ? '&' : '?'}actingSubject=${encodeURIComponent(member.actor)}`,
        undefined,
        member.token,
      );
    const report = async (image: Image, category = 'harassment', extra = {}) =>
      json<Receipt>(
        await call('POST', '/v1/public-reports', {
          profile: 'public-report-v1',
          target: `https://rezics.com/id/${image.asset}`,
          category,
          statement: 'Please review the exact retained image.',
          contentLanguage: 'en',
          ...extra,
        }),
        201,
      );
    const claim = async (receipt: Receipt, member = staff) => {
      const key = randomUUID();
      await json(
        await call(
          'POST',
          `/v1/safety-cases/${receipt.caseId}/claim`,
          { actingSubject: member.actor, idempotencyKey: key },
          member.token,
          key,
        ),
      );
    };
    const key = randomUUID();
    const rule = await json<{ ref: string; revision: string; digest: string }>(
      await call(
        'POST',
        '/v1/governance/rules',
        {
          profile: 'governance-rule-v1',
          ref: `urn:g744:rule:${randomUUID()}`,
          scopeId: 'governance:platform',
          actingSubject: staff.actor,
          expectedRevision: null,
          document: { rule: 'Launch safety policy' },
          idempotencyKey: key,
        },
        staff.token,
        key,
      ),
      201,
    );
    const target = (image: Image): DecisionInput['targets'][number] => ({
      owner: 'content',
      resource: `https://rezics.com/id/${image.asset}`,
      component: 'body',
      locator: null,
      scopeKind: 'exact_revision',
      revision: image.revision,
      expectedHead: image.revision,
      effect: 'disclosure',
    });
    const input = async (
      receipt: Receipt,
      image: Image,
      outcome: DecisionInput['outcome'] = 'restrict',
      reversesDecisionId: string | null = null,
      answersStepId: string | null = null,
    ): Promise<DecisionInput> => {
      await claim(receipt);
      const view = await json<{ generation: string; reports: { evidenceDigest: string }[] }>(
        await read(`/v1/safety-cases/${receipt.caseId}`),
      );
      return {
        caseId: receipt.caseId,
        expectedGeneration: view.generation,
        actingSubject: staff.actor,
        outcome,
        targets: [target(image)],
        rule: { ref: rule.ref, revision: rule.revision, digest: rule.digest },
        evidenceDigest: view.reports[0]!.evidenceDigest,
        reversesDecisionId,
        answersStepId,
        rationale: 'The retained evidence supports this decision.',
        disclosure: 'parties',
        reasons: fixtureReasons,
        idempotencyKey: randomUUID(),
      };
    };
    const decide = (body: DecisionInput) =>
      call(
        'POST',
        `/v1/safety-cases/${body.caseId}/decisions`,
        body,
        staff.token,
        body.idempotencyKey,
      );
    const complete = async (body: DecisionInput) => {
      const accepted = await json<DecisionResult>(await decide(body), 202);
      expect(accepted.operation.status).toBe('accepted');
      const completed = await json<DecisionResult>(await decide(body));
      expect(completed.operation.status).toBe('completed');
      return completed;
    };
    const produce = async () => {
      for (let i = 0; i < 20; i++) if (!(await producer.runAccessOnce())) return;
      throw new Error('Safety producer preparation exceeded its bounded fixture inventory');
    };
    const clearance = async (image: Image) =>
      (
        await stack.contentPool.query<{ clearance: string }>(
          'SELECT media.delivery_clearance(p) AS clearance FROM media.representation p WHERE id = $1',
          [image.representation],
        )
      ).rows[0]!.clearance;
    return {
      stack,
      deps,
      app,
      staff,
      backup,
      author,
      governance,
      notifications,
      producer,
      safetyAlerts,
      call,
      read,
      report,
      claim,
      target,
      input,
      decide,
      complete,
      produce,
      clearance,
      setClock: (now: Date) => {
        clock = now;
      },
      stop: stack.stop,
    };
  } catch (error) {
    await stack.stop();
    throw error;
  }
}
