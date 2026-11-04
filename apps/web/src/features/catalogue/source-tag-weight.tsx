import { m } from '../../paraglide/messages.js';
import type { Stmt } from '../pages/shared';

const WEIGHT = 'rezics:sourceTagWeight';
const METRIC = 'rezics:sourceTagWeightMetric';
const SNAPSHOT = 'rezics:sourceSnapshot';
const SOURCE_TAG_ID = 'rezics:sourceTagId';
const VNDB_DOCS = 'https://api.vndb.org/kana#post-vn';
const RECORD_URL = /^https:\/\/vndb\.org\/v[1-9][0-9]{0,9}$/u;
const SNAPSHOT_ID = /^unversioned:sha256:[0-9a-f]{64}$/u;
const TAG_ID = /^g[1-9][0-9]{0,9}$/u;

type Reading =
  | { state: 'absent' }
  | { state: 'empty' | 'unavailable' | 'unsupported' }
  | { state: 'available'; amount: string; recordUrl: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reading(statement: Stmt): Reading {
  const weights = statement.qualifiers.filter((item) => item.property.id === WEIGHT);
  const metrics = statement.qualifiers.filter((item) => item.property.id === METRIC);
  if (!weights.length && !metrics.length) return { state: 'absent' };
  if (metrics.length !== 1) return metrics.length > 1 ? { state: 'unavailable' } : { state: 'unavailable' };
  const metric = metrics[0]!.value;
  if (metric.type !== 'value' || typeof metric.content !== 'string') return { state: 'unavailable' };
  if (metric.content !== 'vndbTagsRating') return { state: 'unsupported' };
  if (weights.length !== 1) return { state: 'unavailable' };

  const weight = weights[0]!.value;
  if (weight.type === 'novalue') return { state: 'empty' };
  if (weight.type !== 'value' || !isRecord(weight.content)) return { state: 'unavailable' };
  const content = weight.content;
  if (
    typeof content.amount !== 'string' ||
    !/^\+?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(content.amount) ||
    content.unit !== '1' ||
    'lowerBound' in content ||
    'upperBound' in content
  )
    return { state: 'unavailable' };
  if (content.amount.length > 127) return { state: 'unavailable' };
  const amount = content.amount.replace(/^\+/u, '');
  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 3) return { state: 'unavailable' };

  const source = statement.references.flatMap((reference) => {
    const recordUrls = reference.parts.flatMap((part) =>
      part.property.id === 'schema:url' && part.value.type === 'value' && typeof part.value.content === 'string'
        ? [part.value.content]
        : [],
    );
    const revisions = reference.parts.flatMap((part) =>
      part.property.id === SNAPSHOT && part.value.type === 'value' && typeof part.value.content === 'string'
        ? [part.value.content]
        : [],
    );
    const tagIds = reference.parts.flatMap((part) =>
      part.property.id === SOURCE_TAG_ID && part.value.type === 'value' && typeof part.value.content === 'string'
        ? [part.value.content]
        : [],
    );
    const recordUrl = recordUrls.find((url) => RECORD_URL.test(url));
    return recordUrl &&
      revisions.length === 1 &&
      tagIds.length === 1 &&
      SNAPSHOT_ID.test(revisions[0]!) &&
      TAG_ID.test(tagIds[0]!)
      ? [recordUrl]
      : [];
  });
  const documentation = statement.references.some((reference) =>
    reference.parts.some(
      (part) => part.property.id === 'schema:url' && part.value.type === 'value' && part.value.content === VNDB_DOCS,
    ),
  );
  if (source.length !== 1 || !documentation) return { state: 'unavailable' };
  return { state: 'available', amount, recordUrl: source[0]! };
}

/** A source metric adapter. Its evidence stays on this exact association, outside viewer actions. */
export function SourceTagWeight({
  statement,
  locale,
  showAbsent = false,
}: {
  statement: Stmt;
  locale: string;
  showAbsent?: boolean;
}) {
  const result = reading(statement);
  const options = { locale: locale as never };
  if (result.state === 'absent')
    return showAbsent ? (
      <span data-slot="source-tag-weight" data-state="absent" className="text-xs text-muted-foreground">
        {m.subject_source_tag_weight_absent({}, options)}
      </span>
    ) : null;
  if (result.state === 'unsupported')
    return (
      <span data-slot="source-tag-weight" data-state="unsupported" className="text-xs text-muted-foreground">
        {m.subject_source_tag_weight_unsupported({}, options)}
      </span>
    );
  if (result.state === 'empty')
    return (
      <span data-slot="source-tag-weight" data-state="empty" className="text-xs text-muted-foreground">
        {m.subject_source_tag_weight_empty({}, options)}
      </span>
    );
  if (result.state !== 'available')
    return (
      <span data-slot="source-tag-weight" data-state="unavailable" className="text-xs text-muted-foreground">
        {m.subject_source_tag_weight_unavailable({}, options)}
      </span>
    );
  return (
    <span
      data-slot="source-tag-weight"
      data-state="available"
      className="inline-flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground"
    >
      <span title={m.subject_source_tag_weight_explanation({}, options)}>
        {m.subject_source_tag_weight_value({ value: result.amount }, options)}
      </span>
      <a className="underline underline-offset-4" href={VNDB_DOCS}>
        {m.subject_source_tag_weight_source({}, options)}
      </a>
      <a className="underline underline-offset-4" href={result.recordUrl}>
        {m.subject_source_tag_weight_record({}, options)}
      </a>
    </span>
  );
}
