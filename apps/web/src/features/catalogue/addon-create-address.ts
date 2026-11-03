import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { m } from '../../paraglide/messages.js';
import type { SnakInput, StatementInput } from './statement-editor';
import { statementHolderKey } from './statement-editor-view';
import { controlId, presentStatementViolations } from './statement-validation-presentation';

export type AddonHolderKind = 'fact' | 'base';
export type AddonCapturedHolder = { kind: AddonHolderKind; key: string; property: string };
export type AddonAddressTarget = { id: string; label: string };

export function addonFactElementId(key: string) {
  return `game-initial-${key}`;
}
export function addonBaseElementId(key: string) {
  return `addon-base-${key}`;
}

/** Same concatenation order as addonInitialDraft: independent facts, then the explicit base. */
export function captureAddonHolders(
  facts: readonly { key: string; statement: StatementInput }[],
  base: { key: string; statement: StatementInput } | undefined,
): AddonCapturedHolder[] {
  return [
    ...facts.map((row) => ({ kind: 'fact' as const, key: row.key, property: row.statement.property.id })),
    ...(base ? [{ kind: 'base' as const, key: base.key, property: base.statement.property.id }] : []),
  ];
}

function decodePointer(pointer: string): string[] | undefined {
  if (!pointer.startsWith('/') || /~(?![01])/.test(pointer)) return;
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function liveRow(
  holder: AddonCapturedHolder,
  facts: readonly { key: string; statement: StatementInput }[],
  base: { key: string; statement: StatementInput } | undefined,
): { key: string; statement: StatementInput } | undefined {
  if (holder.kind === 'base') return base?.key === holder.key ? base : undefined;
  return facts.find((row) => row.key === holder.key);
}

function elementId(holder: AddonCapturedHolder) {
  return holder.kind === 'base' ? addonBaseElementId(holder.key) : addonFactElementId(holder.key);
}

function removedLabel(property: string, release: Release, locale: string) {
  const o = { locale: locale as never };
  const name = pickText(release.properties[property]?.labels ?? {}, locale).text || property;
  return `${name} · ${m.addon_create_review_removed({}, o)}`;
}

function nestedControl(
  pointerTail: string[],
  row: { key: string; statement: StatementInput },
  holder: AddonCapturedHolder,
  release: Release,
  locale: string,
): AddonAddressTarget | undefined {
  const id = elementId(holder);
  const o = { locale: locale as never };
  const name =
    pickText(release.properties[row.statement.property.id]?.labels ?? {}, locale).text || row.statement.property.id;
  if (
    !pointerTail.length ||
    (holder.kind === 'base' &&
      (pointerTail[0] === 'value' || pointerTail[0] === 'property' || pointerTail[0] === 'rank'))
  )
    return { id: `${id}-fact`, label: name };
  let part: StatementInput | SnakInput = row.statement;
  let address = 'fact';
  let section = '';
  if (pointerTail[0] === 'qualifiers' && /^(0|[1-9]\d*)$/.test(pointerTail[1] ?? '')) {
    const qualifier = row.statement.qualifiers?.[Number(pointerTail[1])];
    if (!qualifier) return { id: `${id}-qualifiers`, label: `${name} · ${m.correction_qualifiers({}, o)}` };
    part = qualifier;
    address = `qualifier-${pointerTail[1]}`;
    section = `${m.correction_qualifiers({}, o)} ${Number(pointerTail[1]) + 1}`;
  } else if (pointerTail[0] === 'references' && pointerTail.length === 1) {
    return { id: `${id}-references`, label: `${name} · ${m.correction_references({}, o)}` };
  } else if (
    pointerTail[0] === 'references' &&
    /^(0|[1-9]\d*)$/.test(pointerTail[1] ?? '') &&
    pointerTail[2] === 'parts' &&
    /^(0|[1-9]\d*)$/.test(pointerTail[3] ?? '')
  ) {
    const citation = row.statement.references[Number(pointerTail[1])]?.parts[Number(pointerTail[3])];
    if (!citation) return { id: `${id}-references`, label: `${name} · ${m.correction_references({}, o)}` };
    part = citation;
    address = `reference-${pointerTail[1]}-part-${pointerTail[3]}`;
    section = `${m.correction_references({}, o)} ${Number(pointerTail[1]) + 1}`;
  } else if (pointerTail[0] === 'value' || pointerTail[0] === 'property' || pointerTail[0] === 'rank') {
    part = row.statement;
    address = 'fact';
  } else return;
  const suffix = '/' + pointerTail.join('/');
  const path = suffix
    .replace(/^\/qualifiers\/(?:0|[1-9]\d*)/, '')
    .replace(/^\/references\/(?:0|[1-9]\d*)\/parts\/(?:0|[1-9]\d*)/, '');
  if (release.properties[part.property.id]?.datatype === 'wikibase-item') {
    if (path !== '/value/content' && path !== '/value' && path !== '') return;
    return {
      id: controlId(id, address, 'value'),
      label: [name, section, pickText(release.properties[part.property.id]?.labels ?? {}, locale).text]
        .filter(Boolean)
        .join(' · '),
    };
  }
  const presented = presentStatementViolations(
    [{ pointer: `/statement${suffix}`, code: 'invalid_format' }],
    row.statement,
    release,
    locale,
    id,
  )[0];
  if (!presented) return;
  if (holder.kind === 'fact' && part !== row.statement) {
    const key = statementHolderKey(part);
    if (key !== undefined) {
      const field = (
        ['state', 'value', 'date', 'amount', 'unit', 'lowerBound', 'upperBound', 'text', 'language'] as const
      ).find(
        (candidate) =>
          presented.target === controlId(id, address, candidate) || presented.target.endsWith(`-${candidate}`),
      );
      if (field)
        return {
          id: controlId(id, `part-${key}`, field),
          label: [name, presented.label].filter(Boolean).join(' · '),
        };
    }
  }
  if (
    presented.target === `${id}-references` ||
    presented.target === `${id}-qualifiers` ||
    presented.target === `${id}-fact` ||
    presented.target.startsWith(`${id}-${address}-`)
  )
    return { id: presented.target, label: [name, presented.label].filter(Boolean).join(' · ') };
}

/** Resolve a native diagnostic to the captured holder, never a later neighbour or the facts group. */
export function addonCreateControl(
  pointer: string,
  captured: readonly AddonCapturedHolder[],
  facts: readonly { key: string; statement: StatementInput }[],
  base: { key: string; statement: StatementInput } | undefined,
  release: Release,
  locale: string,
  factsId: string,
): AddonAddressTarget | undefined {
  const o = { locale: locale as never };
  const segments = decodePointer(pointer);
  if (!segments) return;
  const [kind, property, ordinal, ...nested] = segments;
  if (kind !== 'statements') return;
  if (!property) {
    return { id: factsId, label: m.addon_create_review_unaddressable({}, o) };
  }
  if (ordinal === undefined) {
    const matches = captured.filter((holder) => holder.property === property);
    if (matches.length === 1) {
      const row = liveRow(matches[0]!, facts, base);
      if (!row) return { id: `addon-removed-${matches[0]!.key}`, label: removedLabel(property, release, locale) };
      return {
        id: `${elementId(matches[0]!)}-fact`,
        label: pickText(release.properties[property]?.labels ?? {}, locale).text || property,
      };
    }
    return { id: factsId, label: m.addon_create_review_unaddressable({}, o) };
  }
  if (!/^(0|[1-9]\d*)$/.test(ordinal)) {
    return { id: factsId, label: m.addon_create_review_unaddressable({}, o) };
  }
  const holder = captured.filter((entry) => entry.property === property)[Number(ordinal)];
  if (!holder) return { id: factsId, label: m.addon_create_review_unaddressable({}, o) };
  const row = liveRow(holder, facts, base);
  if (!row) return { id: `addon-removed-${holder.key}`, label: removedLabel(property, release, locale) };
  return (
    nestedControl(nested, row, holder, release, locale) ?? {
      id: factsId,
      label: m.addon_create_review_unaddressable({}, o),
    }
  );
}
