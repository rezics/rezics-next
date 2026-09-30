// SPDX-License-Identifier: Apache-2.0
import type { Locator } from '../protocol/locator.ts';
import {
  source,
  bounds,
  quoteSelector,
  verified,
  type ParsedText,
  type TextUnit,
} from './types.ts';

function literal(value: string): { text: string; rest: string } | undefined {
  const delimiter = value[0];
  if (delimiter !== '"' && delimiter !== "'") return undefined;
  let text = '';
  for (let i = 1; i < value.length; i++) {
    const char = value[i]!;
    if (char === delimiter) return { text, rest: value.slice(i + 1).trim() };
    if (char !== '\\') {
      text += char;
      continue;
    }
    const escaped = value[++i];
    if (!escaped) throw new Error('Unterminated Ren’Py literal');
    const simple: Record<string, string> = {
      n: '\n',
      r: '\r',
      t: '\t',
      '\\': '\\',
      '"': '"',
      "'": "'",
    };
    if (escaped in simple) text += simple[escaped];
    else if (['u', 'U', 'x'].includes(escaped)) {
      const count = escaped === 'U' ? 8 : escaped === 'u' ? 4 : 2;
      const hex = value.slice(i + 1, i + 1 + count);
      if (!new RegExp(`^[0-9a-fA-F]{${count}}$`).test(hex))
        throw new Error('Unsupported Ren’Py escape');
      const point = Number.parseInt(hex, 16);
      if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff))
        throw new Error('Invalid Ren’Py Unicode escape');
      text += String.fromCodePoint(point);
      i += count;
    } else throw new Error('Unsupported Ren’Py literal escape');
  }
  throw new Error('Unterminated Ren’Py literal');
}
interface Guard {
  indent: number;
  value: string;
  menu?: boolean;
}
/** Static literal inspection only: route guards are conditions, never evaluated paths. */
export function parseRenpy(bytes: Uint8Array): ParsedText {
  let script: string;
  try {
    script = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Ren’Py source must be UTF-8 literal .rpy text');
  }
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(script)) throw new Error('Unsupported Ren’Py input');
  const pinned = source(bytes, 'text/x-renpy');
  const units: TextUnit[] = [];
  let label: string | undefined,
    utterance = 0,
    skipped: number | undefined,
    terminated: number | undefined;
  let guards: Guard[] = [],
    labelUnits: TextUnit[] = [];
  const labels = new Set<string>();
  const lines = script.split(/\r?\n/);
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    const raw = lines[lineNumber]!;
    if (/^\s*#|^\s*$/.test(raw)) continue;
    if (/^\s*\t/.test(raw)) throw new Error('Unsupported Ren’Py indentation (use spaces)');
    const indent = raw.length - raw.trimStart().length,
      line = raw.trim();
    if (skipped !== undefined && indent > skipped) continue;
    skipped = undefined;
    if (
      /^(?:init(?:\s+-?\d+)?\s+)?python(?:\s+(?:hide|early))?(?:\s+in\s+\w+)?:/.test(line) ||
      /^(?:init|define|default|screen|transform)\b/.test(line)
    ) {
      skipped = indent;
      continue;
    }
    if (line.startsWith('$')) continue;
    const labelMatch = /^label\s+([\w.]+)\s*:\s*(?:#.*)?$/.exec(line);
    if (labelMatch) {
      label = labelMatch[1]!;
      if (label.length > 256) throw new Error('Ren’Py label exceeds the locator limit');
      if (labels.has(label)) throw new Error('Duplicate Ren’Py label');
      labels.add(label);
      utterance = 0;
      guards = [];
      labelUnits = [];
      terminated = undefined;
      continue;
    }
    if (!label) continue;
    guards = guards.filter((guard) => guard.indent < indent);
    if (terminated !== undefined && indent > terminated) continue;
    terminated = undefined;
    const control = /^(if|elif|else|while)\b(.*?)\s*:\s*(?:#.*)?$/.exec(line);
    if (control) {
      guards.push({ indent, value: `${label}:line-${lineNumber + 1}:${control[1]}${control[2]}` });
      continue;
    }
    if (/^menu(?:\s+[\w.]+)?\s*:\s*(?:#.*)?$/.test(line)) {
      guards.push({ indent, value: `${label}:menu-${lineNumber + 1}`, menu: true });
      continue;
    }
    const jump = /^jump\s+(.+?)\s*(?:#.*)?$/.exec(line);
    if (jump) {
      const route = guards.map((guard) => guard.value);
      const target = /^\w[\w.]*$/.test(jump[1]!) ? jump[1]! : 'dynamic (not evaluated)';
      for (const unit of labelUnits)
        if (route.every((guard) => unit.route?.includes(guard))) {
          (unit.jumps ??= []).push(target);
          const guard = `jump-line-${lineNumber + 1}:${target}`;
          (unit.route ??= []).push(guard);
          if (unit.locator.selector.type === 'ScriptSelector')
            unit.locator.selector.route = [...unit.route];
        }
      // Statements after a jump in this block cannot be reached by fall-through.
      terminated = indent - 1;
      continue;
    }
    if (/^return\b/.test(line)) {
      terminated = indent - 1;
      continue;
    }
    // Unsupported block forms may contain Python/custom-language literals; skip them.
    if (!/^['\"]/.test(line) && /:\s*(?:#.*)?$/.test(line)) {
      skipped = indent;
      continue;
    }
    let speaker: string | null = null,
      value = line;
    if (!/^['"]/.test(value)) {
      const quoteIndex = value.search(/['"]/);
      if (quoteIndex < 0) continue;
      const prefix = value.slice(0, quoteIndex).trim();
      // Only an identifier plus literal say attributes is a static speaker.
      if (!/^[A-Za-z_]\w*(?:\s+[A-Za-z_]\w*)*$/.test(prefix)) speaker = null;
      else speaker = prefix.split(/\s+/)[0]!;
      if (
        /^(?:play|queue|scene|show|hide|call|image|voice|extend|pause|window|with)\b/.test(prefix)
      )
        continue;
      value = value.slice(quoteIndex);
    }
    const parsed = literal(value);
    if (!parsed?.text) continue;
    const isChoice = /^\s*(?:if\s+.*?)?:\s*(?:#.*)?$/.test(parsed.rest);
    if (isChoice && !guards.some((guard) => guard.menu)) continue;
    if (parsed.rest && !isChoice && !/^(?:#.*|(?:with|nointeract|interact)\b.*)$/.test(parsed.rest))
      continue;
    const route = guards.map((guard) => guard.value);
    if (isChoice)
      route.push(
        `${label}:choice-${lineNumber + 1}${parsed.rest.slice(0, parsed.rest.indexOf(':'))}`,
      );
    const ordinal = units.length;
    const locator: Locator = {
      version: 'rezics-locator-v1',
      source: pinned,
      selector: {
        type: 'ScriptSelector',
        label,
        unit: 'utterance',
        utterance: utterance++,
        ...(route.length ? { route } : {}),
      },
    };
    const unit: TextUnit = {
      id: `rpy-${ordinal}`,
      ordinal,
      kind: 'utterance',
      label,
      text: parsed.text,
      locator,
      speaker,
      route,
      warnings: [
        'Static route guards are not proof of runtime reachability',
        ...(/\[(?!\[)/.test(parsed.text)
          ? ['Text interpolation is retained literally, never evaluated']
          : []),
      ],
    };
    units.push(unit);
    labelUnits.push(unit);
    if (isChoice) guards.push({ indent, value: route.at(-1)! });
  }
  if (!units.length) throw new Error('Unsupported Ren’Py script: no literal utterances in labels');
  return {
    units,
    locate(unit, start, end) {
      bounds(unit.text, start, end);
      if (units[unit.ordinal] !== unit) throw new Error('Unit does not belong to this file');
      // ScriptSelector identifies the utterance. A quote narrows it to a passage.
      const exact = unit.text.slice(start, end);
      if (unit.text.indexOf(exact) !== unit.text.lastIndexOf(exact))
        throw new Error('Repeated quote within an utterance is ambiguous; choose a longer passage');
      return { ...unit.locator, quote: quoteSelector(unit.text, start, end) };
    },
    verify(locator) {
      if (locator.selector.type !== 'ScriptSelector')
        throw new Error('Ren’Py requires a script locator');
      const selector = locator.selector;
      const unit = units.find(
        (candidate) =>
          candidate.locator.selector.type === 'ScriptSelector' &&
          candidate.locator.selector.label === selector.label &&
          candidate.locator.selector.utterance === selector.utterance,
      );
      if (!unit || JSON.stringify(selector.route ?? []) !== JSON.stringify(unit.route ?? []))
        throw new Error('Ren’Py label, utterance or route guard does not match');
      let start = 0,
        end = unit.text.length;
      if (locator.quote) {
        start = unit.text.indexOf(locator.quote.exact);
        end = start + locator.quote.exact.length;
        if (
          start < 0 ||
          unit.text.lastIndexOf(locator.quote.exact) !== start ||
          !unit.text.slice(0, start).endsWith(locator.quote.prefix ?? '') ||
          !unit.text.slice(end).startsWith(locator.quote.suffix ?? '')
        )
          throw new Error('Ren’Py quote cannot be resolved unambiguously');
      }
      return verified(locator, unit.text, start, end);
    },
  };
}
