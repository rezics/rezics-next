import type { KernelClient } from '@rezics/client';
import { m } from '../paraglide/messages.js';
import { validateVerificationDraft } from './verification-validation';

export type VerificationInput = {
  subject: string;
  statement: string;
  links: { label: string; url: string }[];
  idempotencyKey: string;
};

type VerificationResponse = NonNullable<
  Awaited<ReturnType<ReturnType<KernelClient['accounts']>['verification']['get']>>['data']
>;
export type AgentVerificationRequest = NonNullable<VerificationResponse['verificationRequest']>;

export type VerificationCommandResult =
  | { ok: true; verificationRequest: AgentVerificationRequest }
  | { ok: false; status: number; message: string; outcome?: 'refused' };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

/** Native account response validation; an absent or malformed read is never a completed command. */
function validRequest(value: unknown, accountId: string): value is AgentVerificationRequest {
  if (!record(value)) return false;
  return (
    typeof value.id === 'string' &&
    !!value.id &&
    value.accountId === accountId &&
    (value.accountKind === 'actor' || value.accountKind === 'organization') &&
    typeof value.requestedBy === 'string' &&
    typeof value.catalogueSubjectId === 'string' &&
    typeof value.statement === 'string' &&
    Array.isArray(value.links) &&
    value.links.length <= 5 &&
    value.links.every(
      (link: unknown) => record(link) && typeof link.label === 'string' && typeof link.url === 'string',
    ) &&
    typeof value.state === 'string' &&
    ['pending', 'approving', 'approved', 'rejected', 'withdrawn', 'failed'].includes(value.state) &&
    nullableString(value.reason) &&
    nullableString(value.decisionReceiptId) &&
    nullableString(value.decidedBy) &&
    (value.problem === null ||
      (record(value.problem) && typeof value.problem.type === 'string' && typeof value.problem.detail === 'string')) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  );
}

function apiMessage(error: unknown): string {
  if (record(error) && record(error.value) && typeof error.value.detail === 'string') return error.value.detail;
  return m.settings_verification_request_failed();
}

export async function readVerification(client: KernelClient, accountId: string, authorization: string) {
  const result = await client.accounts({ accountId }).verification.get({ headers: { authorization } });
  if (result.error || !result.data) throw new Error(apiMessage(result.error));
  const request = result.data.verificationRequest;
  if (request !== null && !validRequest(request, accountId)) throw new Error(m.settings_verification_load_failed());
  return request;
}

export async function requestVerification(
  client: KernelClient,
  accountId: string,
  authorization: string,
  input: VerificationInput,
): Promise<VerificationCommandResult> {
  if (validateVerificationDraft(input).length)
    return { ok: false, status: 0, message: m.settings_verification_validation(), outcome: 'refused' };
  const result = await client
    .accounts({ accountId })
    .$requestVerification.post(
      { subject: input.subject, statement: input.statement, links: input.links },
      { headers: { authorization, 'idempotency-key': input.idempotencyKey } as { 'idempotency-key': string } },
    );
  if (result.status === 201 && validRequest(result.data?.verificationRequest, accountId))
    return { ok: true, verificationRequest: result.data!.verificationRequest };
  return { ok: false, status: result.status, message: apiMessage(result.error) };
}

export async function withdrawVerification(
  client: KernelClient,
  accountId: string,
  authorization: string,
  idempotencyKey: string,
): Promise<VerificationCommandResult> {
  const result = await client.accounts({ accountId }).$withdrawVerification.post(
    {},
    {
      headers: { authorization, 'idempotency-key': idempotencyKey } as { 'idempotency-key': string },
    },
  );
  if (result.status === 200 && validRequest(result.data?.verificationRequest, accountId))
    return { ok: true, verificationRequest: result.data!.verificationRequest };
  return { ok: false, status: result.status, message: apiMessage(result.error) };
}
