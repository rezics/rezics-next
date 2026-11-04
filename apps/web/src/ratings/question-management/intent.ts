import type {
  QuestionCaptionInput,
  QuestionDefinitionInput,
  QuestionLifecycleInput,
  QuestionManagementAction,
  QuestionManagementIntent,
  QuestionManagementPageData,
  QuestionManagementRead,
  QuestionManagementVisit,
} from './types';

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digestPattern = /^[a-f0-9]{64}$/;
const actions = ['create', 'caption', 'retire', 'restore'] as const;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  return Object.keys(value).length === expected.length && expected.every((key) => key in value);
}

function validDefinition(value: unknown): value is QuestionDefinitionInput {
  const body = record(value);
  const scale = record(body?.scale);
  return Boolean(
    body &&
      exactKeys(body, ['meaning', 'label', 'grain', 'scale']) &&
      typeof body.meaning === 'string' &&
      [...body.meaning].length >= 1 &&
      [...body.meaning].length <= 2000 &&
      !body.meaning.includes('\0') &&
      typeof body.label === 'string' &&
      [...body.label].length >= 1 &&
      [...body.label].length <= 200 &&
      body.label.trim().length > 0 &&
      !body.label.includes('\0') &&
      ['work', 'release', 'episode', 'character'].includes(String(body.grain)) &&
      scale &&
      exactKeys(scale, ['min', 'max', 'displayStep']) &&
      Number.isSafeInteger(scale.min) &&
      Number.isSafeInteger(scale.max) &&
      Number.isSafeInteger(scale.displayStep) &&
      (scale.min as number) >= 0 &&
      (scale.max as number) <= 20 &&
      (scale.min as number) < (scale.max as number) &&
      (scale.displayStep as number) > 0 &&
      ((scale.max as number) - (scale.min as number)) % (scale.displayStep as number) === 0,
  );
}

function validCaption(value: unknown): value is QuestionCaptionInput {
  const body = record(value);
  return Boolean(
    body &&
      exactKeys(body, ['expectedLabelRevision', 'label']) &&
      Number.isSafeInteger(body.expectedLabelRevision) &&
      (body.expectedLabelRevision as number) >= 1 &&
      typeof body.label === 'string' &&
      [...body.label].length >= 1 &&
      [...body.label].length <= 200 &&
      body.label.trim().length > 0 &&
      !body.label.includes('\0'),
  );
}

function validLifecycle(value: unknown): value is QuestionLifecycleInput {
  const body = record(value);
  return Boolean(
    body &&
      exactKeys(body, ['expectedLifecycleRevision']) &&
      Number.isSafeInteger(body.expectedLifecycleRevision) &&
      (body.expectedLifecycleRevision as number) >= 1,
  );
}

export function validQuestionManagementBody(
  action: QuestionManagementAction,
  body: unknown,
): body is QuestionDefinitionInput | QuestionCaptionInput | QuestionLifecycleInput {
  return action === 'create'
    ? validDefinition(body)
    : action === 'caption'
      ? validCaption(body)
      : validLifecycle(body);
}

function hrefFor(action: QuestionManagementAction, realmId: string, questionId: string | null) {
  if (action === 'create') return `/v1/realms/${realmId}/rating-questions`;
  if (questionId === null) return null;
  if (action === 'caption') return `/v1/rating-questions/${questionId}/label`;
  return `/v1/rating-questions/${questionId}/$${action}`;
}

export function parseQuestionManagementIntent(value: unknown): QuestionManagementIntent {
  const input = record(value);
  if (
    !input ||
    !exactKeys(input, [
      'action',
      'viewer',
      'realmId',
      'questionId',
      'locale',
      'credentialEpisode',
      'csrfEpisode',
      'csrfToken',
      'sourceObservation',
      'key',
      'href',
      'body',
      'serializedBody',
    ]) ||
    !actions.includes(input.action as (typeof actions)[number]) ||
    typeof input.viewer !== 'string' ||
    !idPattern.test(input.viewer) ||
    typeof input.realmId !== 'string' ||
    !idPattern.test(input.realmId) ||
    (input.questionId !== null && (typeof input.questionId !== 'string' || !idPattern.test(input.questionId))) ||
    typeof input.locale !== 'string' ||
    input.locale.length === 0 ||
    input.locale.length > 35 ||
    typeof input.credentialEpisode !== 'string' ||
    !digestPattern.test(input.credentialEpisode) ||
    typeof input.csrfEpisode !== 'string' ||
    !digestPattern.test(input.csrfEpisode) ||
    typeof input.csrfToken !== 'string' ||
    input.csrfToken.length === 0 ||
    input.csrfToken.length > 4096 ||
    typeof input.sourceObservation !== 'string' ||
    !digestPattern.test(input.sourceObservation) ||
    typeof input.key !== 'string' ||
    !idPattern.test(input.key) ||
    typeof input.href !== 'string' ||
    typeof input.serializedBody !== 'string' ||
    input.serializedBody.length > 10_000 ||
    input.serializedBody !== JSON.stringify(input.body)
  )
    throw new TypeError('Invalid question management intent');

  const action = input.action as QuestionManagementAction;
  const questionId = input.questionId as string | null;
  const expectedHref = hrefFor(action, input.realmId, questionId);
  const validBody =
    action === 'create'
      ? questionId === null && validDefinition(input.body)
      : action === 'caption'
        ? questionId !== null && validCaption(input.body)
        : questionId !== null && validLifecycle(input.body);
  if (!validBody || expectedHref === null || input.href !== expectedHref)
    throw new TypeError('Invalid question management intent');

  const body = Object.freeze(
    action === 'create'
      ? { ...(input.body as QuestionDefinitionInput), scale: Object.freeze({ ...(input.body as QuestionDefinitionInput).scale }) }
      : { ...(input.body as QuestionCaptionInput | QuestionLifecycleInput) },
  );
  return Object.freeze({ ...input, action, questionId, body }) as QuestionManagementIntent;
}

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function captureQuestionManagementIntent(input: {
  action: QuestionManagementAction;
  read: Extract<QuestionManagementRead, { state: 'ready' }>;
  visit: QuestionManagementVisit;
  locale: string;
  csrfToken: string;
  body: QuestionDefinitionInput | QuestionCaptionInput | QuestionLifecycleInput;
}): Promise<QuestionManagementIntent> {
  const { page } = input.read;
  if (
    input.visit.state !== 'preparing' ||
    input.visit.viewer !== input.read.viewer ||
    input.visit.locale !== input.locale ||
    input.visit.realmId !== page.realmId ||
    page.viewer.accountId !== input.read.viewer ||
    !input.read.credentialEpisode ||
    !input.read.csrfEpisode
  )
    throw new TypeError('Question management visit is no longer current');

  let questionId: string | null = null;
  let href: string | null = null;
  if (input.action === 'create') {
    if (!page.actions.create) throw new TypeError('Question creation is unavailable');
    href = page.actions.create.href;
  } else {
    const selected = page.selected;
    if (!selected) throw new TypeError('No exact question is selected');
    questionId = selected.question.id;
    href =
      input.action === 'caption'
        ? selected.actions.caption?.href ?? null
        : selected.actions.lifecycle?.href ?? null;
    if (!href) throw new TypeError('Question management action is unavailable');
    if (
      (input.action === 'caption' &&
        (input.body as QuestionCaptionInput).expectedLabelRevision !== selected.actions.caption?.expectedLabelRevision) ||
      ((input.action === 'retire' || input.action === 'restore') &&
        (input.body as QuestionLifecycleInput).expectedLifecycleRevision !==
          selected.actions.lifecycle?.expectedLifecycleRevision)
    )
      throw new TypeError('Question management head changed');
  }

  const raw = {
    action: input.action,
    viewer: input.read.viewer,
    realmId: page.realmId,
    questionId,
    locale: input.locale,
    credentialEpisode: input.read.credentialEpisode,
    csrfEpisode: input.read.csrfEpisode,
    csrfToken: input.csrfToken,
    sourceObservation: await digest(JSON.stringify([page, input.read.selectedQuestionId, input.read.cursor])),
    key: crypto.randomUUID(),
    href,
    body: input.body,
    serializedBody: JSON.stringify(input.body),
  };
  return parseQuestionManagementIntent(raw);
}

export function questionManagementIntentMatchesVisit(
  intentValue: unknown,
  visit: QuestionManagementVisit,
  csrfToken: string | null,
  locale: string,
): QuestionManagementIntent | null {
  let intent: QuestionManagementIntent;
  try {
    intent = parseQuestionManagementIntent(intentValue);
  } catch {
    return null;
  }
  if (
    visit.state !== 'preparing' ||
    intent.viewer !== visit.viewer ||
    intent.realmId !== visit.realmId ||
    intent.locale !== visit.locale ||
    intent.locale !== locale ||
    intent.credentialEpisode !== visit.credentialEpisode ||
    intent.csrfEpisode !== visit.csrfEpisode ||
    intent.csrfToken !== csrfToken ||
    (intent.action === 'create'
      ? visit.selectedQuestionId !== null
      : visit.selectedQuestionId !== intent.questionId)
  )
    return null;
  return intent;
}

export function questionManagementIntentMatchesPage(intent: QuestionManagementIntent, page: QuestionManagementPageData) {
  if (intent.realmId !== page.realmId || intent.viewer !== page.viewer.accountId) return false;
  if (intent.action === 'create') return intent.questionId === null && page.actions.create?.href === intent.href;
  if (page.selected?.question.id !== intent.questionId) return false;
  return intent.action === 'caption'
    ? page.selected.actions.caption?.href === intent.href &&
        page.selected.actions.caption.expectedLabelRevision === intent.body.expectedLabelRevision
    : page.selected.actions.lifecycle?.href === intent.href &&
        page.selected.actions.lifecycle.expectedLifecycleRevision === intent.body.expectedLifecycleRevision;
}
