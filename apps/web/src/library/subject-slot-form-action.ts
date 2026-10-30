import { createServerOnlyFn } from '@tanstack/react-start';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { applySubjectLabelMutation } from './subject-labels.ts';
import { validateSubjectLabelMutation } from './subject-slot-actions';

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
    const form = await request.clone().formData();
    const one = (name: string): string | null => {
      const values = form.getAll(name);
      return values.length === 1 && typeof values[0] === 'string' ? values[0] : null;
    };
    const intents = form.getAll('intent');
    const intent = intents.length === 1 && typeof intents[0] === 'string' ? intents[0] : null;
    const subjectId = one('subjectId');
    if (!subjectId || subjectId.length > 128) return { ok: false as const, reason: 'unavailable' as const };
    const idempotencyKey = crypto.randomUUID();
    const sessionEnv = env as Partial<SessionEnv>;
    const client = kernelClient();
    if (intent === 'assign-by-name') {
      const name = one('name');
      if (name === null || name.length > 200) return { ok: false as const, reason: 'unavailable' as const };
      const input = validateSubjectLabelMutation({
        intent: 'create-and-assign',
        subjectId,
        name,
        createKey: crypto.randomUUID(),
        idempotencyKey,
      });
      return applySubjectLabelMutation(request, sessionEnv, input, client);
    }
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
