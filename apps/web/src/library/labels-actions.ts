import { createServerFn, createServerOnlyFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { handleLabelForm, submitLabel, validateLabelInput } from './labels-read';

// Every form preserves its own Idempotency-Key across retries, as Collection forms do.
export const manageLabel = createServerFn({ method: 'POST' })
  .validator(validateLabelInput)
  .handler(({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return submitLabel(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });
export const labelsFormPost = createServerOnlyFn(({ request }: { request: Request }) =>
  handleLabelForm(kernelClient(), request, env as Partial<SessionEnv>),
);

/** One signed prefix page for the existing subject picker. */
export const readSubjectLabelPage = createServerFn({ method: 'GET' })
  .validator((input: { query: string; cursor?: string }) => {
    if (
      !input ||
      typeof input.query !== 'string' ||
      input.query.length > 4096 ||
      (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 4096))
    )
      throw new Error('Invalid label prefix page');
    return input;
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const { searchSubjectLabels } = await import('./subject-labels.ts');
    return searchSubjectLabels({
      client: kernelClient(),
      request: getRequest(),
      sessionEnv: env as Partial<SessionEnv>,
      query: data.query,
      ...(data.cursor ? { cursor: data.cursor } : {}),
    });
  });

/** A removal captures the native assignment CAS before sending any destructive command. */
export const readShelfLabelAssignment = createServerFn({ method: 'GET' })
  .validator((input: { subjectId: string; labelId: string }) => {
    if (!input || [input.subjectId, input.labelId].some((id) => typeof id !== 'string' || !id || id.length > 128))
      throw new Error('Invalid shelf label assignment');
    return { subjectId: input.subjectId, labelId: input.labelId };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const { readSubjectSlotSession } = await import('./subject-slot');
    const identity = await readSubjectSlotSession(getRequest(), env as Partial<SessionEnv>);
    if (identity.state !== 'signed-in')
      return { state: identity.state === 'signed-out' ? ('signed-out' as const) : ('unavailable' as const) };
    const provenance = { viewer: identity.subject, csrfToken: identity.csrfToken, ...data };
    try {
      const { readSubjectLabelAssignments } = await import('./subject-labels.ts');
      const labels = await readSubjectLabelAssignments(kernelClient(), data.subjectId, identity.authorization);
      const assignment = labels.find((label) => label.labelId === data.labelId);
      return {
        state: 'loaded' as const,
        provenance,
        assignment: assignment ? { id: assignment.id, revision: assignment.revision } : null,
      };
    } catch {
      return { state: 'unavailable' as const, provenance };
    }
  });
