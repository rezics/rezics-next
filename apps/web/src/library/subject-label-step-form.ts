import { m } from '../paraglide/messages.js';
import type { SubjectLabelStep } from './subject-label-step';

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]!,
  );

/** Ordinary POST continuation: private data stays in the response body, never the address or a name replay. */
export function subjectLabelStepForm(
  request: Request,
  step: SubjectLabelStep,
  csrf: string,
  retry = false,
  reason?: string,
): Response {
  const url = new URL(request.url);
  const action = url.pathname + url.search;
  const message = step.created
    ? m.library_subject_label_steps_created()
    : step.kind === 'create'
      ? m.library_subject_label_steps_create()
      : m.library_subject_label_steps_assign();
  const failure =
    reason === 'conflict'
      ? m.library_subject_label_steps_conflict()
      : reason === 'capacity'
        ? m.library_subject_label_capacity()
        : reason === 'closed'
          ? m.library_subject_label_closed()
          : m.library_subject_label_steps_retry();
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escape(m.library_subject_label_add())}</title></head><body><main>
${!retry ? `<p role="status">${escape(message)}</p>` : ''}${retry ? `<p role="alert">${escape(failure)}</p>` : ''}
${!retry ? `<p>${escape(step.label?.name || step.name)}</p>` : ''}
<form method="post" action="${escape(action)}">
<input type="hidden" name="intent" value="label-step">
<input type="hidden" name="subjectId" value="${escape(step.subjectId)}">
<input type="hidden" name="token" value="${escape(step.token)}">
<input type="hidden" name="csrf_token" value="${escape(csrf)}">
<button type="submit">${escape(retry ? m.library_selection_retry() : m.library_subject_label_steps_continue())}</button>
</form>${!retry ? `<a href="${escape(action)}">${escape(m.library_collection_cancel())}</a>` : ''}
</main></body></html>`;
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}
