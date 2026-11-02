import { createServerOnlyFn } from '@tanstack/react-start';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { applySubjectLabelMutation } from './subject-labels.ts';
import { validateSubjectLabelMutation } from './subject-slot-actions';
import { subjectLabelStepForm } from './subject-label-step-form';
import { readSubjectLabelStep } from './subject-label-step';
import { csrfTokenFromRequest } from '../session/csrf';

/** The ordinary HTML form action is server-only so its kernel client never enters the hydrated subject page. */
export const submitSubjectLabelForm = createServerOnlyFn(async (request: Request) => {
  if (
    request.method !== 'POST' ||
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded'
  )
    return { ok: false as const, reason: 'unavailable' as const };
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > 4 * 1024))
    return { ok: false as const, reason: 'unavailable' as const };
  try {
    if (new TextEncoder().encode(await request.clone().text()).length > 4096)
      return { ok: false as const, reason: 'unavailable' as const };
    const form = await request.clone().formData();
    const one = (name: string): string | null => {
      const values = form.getAll(name);
      return values.length === 1 && typeof values[0] === 'string' ? values[0] : null;
    };
    const intent = one('intent');
    const subjectId = one('subjectId');
    if (!subjectId || subjectId.length > 128) return { ok: false as const, reason: 'unavailable' as const };
    const sessionEnv = env as Partial<SessionEnv>;
    const client = kernelClient();
    if (intent === 'assign-by-name' || intent === 'label-step') {
      // Preparation sends no native write. Each following form submits its exact sealed command.
      const input = validateSubjectLabelMutation(intent === 'label-step'
        ? { intent, subjectId, token: one('token') }
        : { intent: 'create-and-assign', subjectId, name: one('name'),
            createKey: one('createKey'), idempotencyKey: one('idempotencyKey') });
      const result = await applySubjectLabelMutation(request, sessionEnv, input, client);
      const csrf = await csrfTokenFromRequest(request);
      if (!result.ok && result.reason === 'continue' && csrf) return subjectLabelStepForm(request, result.step, csrf);
      if (!result.ok && intent === 'label-step' && csrf && input.intent === 'label-step') {
        // The display is read only from the authenticated capture, never from form-supplied label/name data.
        const step = await readSubjectLabelStep(request, sessionEnv, input);
        if (step) return subjectLabelStepForm(request, step, csrf, true, result.reason);
      }
      return result;
    }
    const idempotencyKey = one('idempotencyKey') ?? crypto.randomUUID();
    if (intent === 'unassign' || intent === 'restore') {
      const labelId = one('labelId');
      const assignmentId = one('assignmentId');
      const revisionValue = one('revision');
      if (!labelId || !assignmentId || !revisionValue || !/^[1-9]\d*$/.test(revisionValue))
        return { ok: false as const, reason: 'unavailable' as const };
      const revision = Number(revisionValue);
      if (!Number.isSafeInteger(revision)) return { ok: false as const, reason: 'unavailable' as const };
      const input = validateSubjectLabelMutation({
        intent,
        subjectId,
        labelId,
        assignmentId,
        revision,
        idempotencyKey,
      });
      return applySubjectLabelMutation(request, sessionEnv, input, client);
    }
  } catch {
    return { ok: false as const, reason: 'unavailable' as const };
  }
  return { ok: false as const, reason: 'unavailable' as const };
});
