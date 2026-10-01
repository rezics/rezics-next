import { Elysia, t } from 'elysia';
import type { Pool } from 'pg';
import { accountFailure, accountJson, accountSession, type AccountAuth } from './http.ts';
import { POLICY_VERSIONS, type PolicyVersion } from './policy-versions.ts';
import { admitRegistration, MARKET_POLICY_VERSION, SignupPolicyProblem } from './market-policy.ts';

export type PolicyAcceptance = { policyId: 'terms' | 'privacy'; versionDigest: string };
export const policyAcceptanceSchema = t.Object(
  {
    acceptedPolicies: t.Array(
      t.Object(
        {
          policyId: t.Union([t.Literal('terms'), t.Literal('privacy')]),
          versionDigest: t.String({ pattern: '^[a-f0-9]{64}$' }),
        },
        { additionalProperties: false },
      ),
      { minItems: 2, maxItems: 2 },
    ),
  },
  { additionalProperties: false },
);

/** Always acknowledge the displayed current text. Previously accepted nonmaterial
 * versions can remain sufficient through the explicit acceptanceDigests list. */
export function validatePolicyAcceptance(
  value: unknown,
  policies: readonly PolicyVersion[] = POLICY_VERSIONS,
): PolicyAcceptance[] {
  if (
    !Array.isArray(value) ||
    value.length !== policies.length ||
    policies.some(
      (policy) =>
        value.filter(
          (item) =>
            item?.policyId === policy.policyId && item.versionDigest === policy.versionDigest,
        ).length !== 1,
    )
  ) {
    throw new SignupPolicyProblem('policy_acceptance_required');
  }
  return policies.map(({ policyId, versionDigest }) => ({ policyId, versionDigest }));
}

export function signupPolicyInput(
  body: Record<string, unknown>,
  country?: string | null,
  policies: readonly PolicyVersion[] = POLICY_VERSIONS,
) {
  // The declaration serves this one admission decision. Retain its policy
  // version. Exact birthday is collected separately when needed.
  admitRegistration(body.minimumAgeConfirmed, country);
  return {
    registrationPolicyVersion: MARKET_POLICY_VERSION,
    // pg serializes objects as JSON; a bare JS array becomes a PostgreSQL array.
    signupPolicies: { acceptedPolicies: validatePolicyAcceptance(body.acceptedPolicies, policies) },
  };
}

/** Cost: one indexed lookup bounded to two policy IDs, independent of journal
 * history. Do not enumerate a person's previous policy receipts to decide. */
export async function policyAcceptanceRequired(
  pool: Pool,
  userId: string,
  policies: readonly PolicyVersion[] = POLICY_VERSIONS,
): Promise<boolean> {
  const result = await pool.query<{ accepted: boolean }>(
    `SELECT bool_and(EXISTS (
    SELECT 1 FROM rezics_policy_acceptance a WHERE a.user_id = $1
      AND a.policy_id = p.id AND a.version_digest = ANY(p.digests))) AS accepted
    FROM jsonb_to_recordset($2::jsonb) AS p(id text, digests text[])`,
    [
      userId,
      JSON.stringify(policies.map((p) => ({ id: p.policyId, digests: p.acceptanceDigests }))),
    ],
  );
  return result.rows[0]?.accepted !== true;
}

export function policyAcceptanceApi(
  auth: AccountAuth,
  pool: Pool,
  policies: readonly PolicyVersion[] = POLICY_VERSIONS,
) {
  const problem = t.Object({ error: t.String() });
  const status = t.Object({ acceptanceRequired: t.Boolean() });
  return new Elysia()
    .get(
      '/api/account/policies',
      {
        response: {
          200: t.Object({
            acceptanceRequired: t.Boolean(),
            policies: t.Array(
              t.Object({
                policyId: t.Union([t.Literal('terms'), t.Literal('privacy')]),
                source: t.String(),
                effectiveDate: t.String(),
                versionDigest: t.String(),
                acceptanceDigests: t.Array(t.String()),
              }),
            ),
          }),
          503: problem,
        },
      },
      async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers });
          return accountJson({
            policies,
            acceptanceRequired: session
              ? await policyAcceptanceRequired(pool, session.user.id, policies)
              : true,
          });
        } catch (error) {
          return accountFailure(error);
        }
      },
    )
    .post(
      '/api/account/policies/acceptance',
      {
        body: policyAcceptanceSchema,
        response: { 200: status, 401: problem, 403: problem, 409: problem, 503: problem },
      },
      async ({ request, body }) => {
        try {
          const session = await accountSession(auth, request);
          const accepted = validatePolicyAcceptance(body.acceptedPolicies, policies);
          // One statement is atomic; replay retains the original acceptance time.
          await pool.query(
            `INSERT INTO rezics_policy_acceptance (user_id, policy_id, version_digest)
          SELECT $1, p."policyId", p."versionDigest" FROM jsonb_to_recordset($2::jsonb)
            AS p("policyId" text, "versionDigest" text) ON CONFLICT DO NOTHING`,
            [session.user.id, JSON.stringify(accepted)],
          );
          return accountJson({ acceptanceRequired: false });
        } catch (error) {
          if (error instanceof SignupPolicyProblem)
            return accountJson({ error: error.reason }, 409);
          return accountFailure(error);
        }
      },
    );
}
