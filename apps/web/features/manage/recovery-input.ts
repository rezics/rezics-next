// These checks admit durable JSON back into the UI, not business authority.
// Main still validates and authorizes every replay of the original request.
type RecordValue = Record<string, unknown>;
export const object = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const nullableText = (value: unknown) => value === null || typeof value === 'string';
const fields = (value: unknown, keys: string[]) => object(value) && keys.every(key => text(value[key]));
const nullableFields = (value: unknown, keys: string[]) => object(value) && keys.every(key => nullableText(value[key]));
const texts = (value: unknown) => Array.isArray(value) && value.every(text);
const named = (value: unknown) => object(value) && text(value.original) && object(value.labels)
  && Object.values(value.labels).every(entry => typeof entry === 'string');
const rule = (value: unknown) => object(value) && text(value.id) && nullableText(value.governanceRule)
  && named(value.title) && named(value.body);
export const validRoleChange = (change: unknown) => object(change) && text(change.roleId)
  && (change.kind === 'role' ? text(change.name) && texts(change.permissions)
    : change.kind === 'assignment' && text(change.member) && typeof change.assigned === 'boolean' && text(change.validUntil));
const basis = (input: RecordValue, actor: string) => input.actingSubject === actor && text(input.expectedGeneration) && text(input.reason);
const reasons = (value: unknown) => object(value) && ['facts', 'scope', 'duration', 'contentLanguage', 'appealRoute']
  .every(key => text(value[key])) && typeof value.automation === 'boolean';
const target = (value: unknown) => object(value) && ['owner', 'resource', 'component', 'scopeKind', 'effect'].every(key => text(value[key]))
  && ['locator', 'revision', 'expectedHead'].every(key => nullableText(value[key]));
export const validItem = (value: unknown) => object(value) && ['id', 'kind', 'generation', 'openedAt', 'state', 'context'].every(key => text(value[key]))
  && fields(value.target, ['owner', 'resource', 'component']) && ['open', 'closed'].includes(String(value.state))
  && nullableText(value.decisionHead) && nullableText(value.authorAgent) && nullableText(value.reasonCode)
  && (value.escalation === null || fields(value.escalation, ['id', 'actingSubject', 'reason', 'escalatedAt', 'target']))
  && (value.submission === null || fields(value.submission, ['revision', 'state']) && object(value.submission)
    && nullableFields(value.submission, ['contribution', 'publicationDecision', 'selectedDraft', 'correctionOf']));
export const validDecision = (value: unknown) => object(value) && ['approve', 'reject', 'request-changes', 'keep', 'remove',
  'interim-restrict', 'final-restrict', 'escalate'].includes(String(value.action)) && nullableText(value.reason) && nullableText(value.note);

export function validRecoveryInput(operation: string, input: unknown, actor: string, key: string): boolean {
  if (!object(input)) return false;
  if (operation.startsWith('zone-attachment:')) return input.actingSubject === actor
    && input.zone === operation.slice('zone-attachment:'.length) && fields(input, ['zone', 'realm']);
  if (operation.startsWith('sanction-appeal:')) return input.actingSubject === actor && input.idempotencyKey === key
    && input.caseId === operation.slice('sanction-appeal:'.length) && input.profile === 'moderation-decision-v1'
    && text(input.expectedGeneration) && ['dismiss', 'restore'].includes(String(input.outcome))
    && Array.isArray(input.targets) && input.targets.length === 0 && input.reversesDecisionId === null && input.answersStepId === null
    && fields(input.rule, ['ref', 'revision', 'digest']) && text(input.evidenceDigest) && reasons(input.reasons)
    && text(input.rationale) && ['private', 'parties', 'public_summary'].includes(String(input.disclosure));
  if (operation === 'settings') return basis(input, actor) && nullableText(input.expectedRulesRevision)
    && object(input.settings) && ['public', 'restricted', 'private'].includes(String(input.settings.visibility))
    && typeof input.settings.reviewRequired === 'boolean' && ['granted', 'members', 'closed'].includes(String(input.settings.whoMaySubmit))
    && Array.isArray(input.settings.rules) && input.settings.rules.every(rule);
  if (operation.startsWith('role:')) return object(input.command) && basis(input.command, actor)
    && validRoleChange(input.command.change) && text(input.digest)
    && (input.impact === undefined || object(input.impact) && fields(input.impact, ['digest', 'generation'])
      && typeof input.impact.exact === 'boolean' && typeof input.impact.affectedCount === 'number'
      && Array.isArray(input.impact.changes) && input.impact.changes.every(change => object(change)
        && text(change.member) && texts(change.gained) && texts(change.lost)));
  if (operation.startsWith('submission:')) return input.actingSubject === actor && text(input.expectedRevision)
    && ['accept', 'reject', 'request-changes'].includes(String(input.outcome)) && nullableText(input.expectedSelectionHead)
    && nullableText(input.publicReason) && nullableText(input.internalNote);
  if (operation.startsWith('report:')) return input.actingSubject === actor && input.idempotencyKey === key
    && input.caseId === operation.slice('report:'.length) && ['moderation-decision-v1', 'rights-restriction-v1'].includes(String(input.profile))
    && text(input.expectedGeneration) && text(input.evidenceDigest) && text(input.outcome)
    && fields(input.rule, ['ref', 'revision', 'digest'])
    && Array.isArray(input.targets) && input.targets.every(target) && reasons(input.reasons)
    && nullableText(input.rationale) && nullableText(input.reversesDecisionId) && nullableText(input.answersStepId) && text(input.disclosure);
  return false;
}
