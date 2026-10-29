/// <reference path="./recheck.d.ts" />
import { checkSync } from 'recheck/lib/browser.js';

// Admission bounds the *expanded* expression before recheck allocates its NFA.
// Counts include nested multiplication, not just the spelling of {n}. Saturate
// by refusing immediately, before any expansion or integer overflow is possible.
const MAX_EXPANSION = 128;
const MAX_DEPTH = 16;
const MAX_COUNT = 64;
const MAX_TRANSITIONS = 256;

function admitted(source: string): boolean {
  let position = 0;
  let repeats = 0;
  const refuse = (): never => { throw new Error('Pattern structure exceeds the analysis profile'); };
  const escape = () => {
    const char = source[position++];
    // Backreferences and Unicode properties are outside this structural profile.
    if (char === undefined || /[1-9kpP]/u.test(char)) refuse();
    if ((char === 'u' || char === 'x') && source[position] === '{') {
      while (position < source.length && source[position++] !== '}') { /* One code point. */ }
    } else if (char === 'u') position += 4;
    else if (char === 'x') position += 2;
    else if (char === 'c') position++;
  };
  const atom = (depth: number): number => {
    const char = source[position++];
    if (char === '\\') escape();
    else if (char === '[') {
      while (position < source.length && source[position] !== ']') {
        if (source[position++] === '\\') escape();
      }
      if (source[position++] !== ']') refuse();
    } else if (char === '(') {
      if (depth >= MAX_DEPTH) refuse();
      let assertion = false;
      if (source[position] === '?') {
        position++;
        const kind = source[position++];
        if (kind === '=' || kind === '!') assertion = true;
        else if (kind !== ':') refuse(); // No lookbehind, named groups or modifiers.
      }
      const start = position;
      const size = expression(depth + 1);
      if (source[position++] !== ')') refuse();
      // A one-character lookahead adds no assertion automaton determinization.
      // This includes the end-of-input assertion used by generated item schemas.
      // Disallow groups, alternatives, anchors and quantifiers inside assertions.
      if (assertion) {
        const end = position - 1;
        position = start;
        if (source[position] === '(' || source[position] === '^' || source[position] === '$') refuse();
        atom(depth + 1);
        if (position !== end) refuse();
        position++;
      }
      return size + 2;
    } else if (char === undefined || '*+?{}'.includes(char)) refuse();
    return 1;
  };
  const expression = (depth: number): number => {
    let size = 0;
    while (position < source.length && source[position] !== ')') {
      if (source[position] === '|') { position++; size++; continue; }
      let cost = atom(depth);
      const quantifier = source[position];
      if (quantifier !== undefined && '*+?{'.includes(quantifier)) {
        position++;
        let copies = 2;
        if (quantifier === '{') {
          const count = () => {
            const start = position;
            let value = 0;
            while (position < source.length && /[0-9]/u.test(source[position]!)) {
              value = value * 10 + Number(source[position++]);
              if (value > MAX_COUNT) refuse();
            }
            if (position === start) refuse();
            return value;
          };
          const minimum = count();
          let maximum = minimum;
          if (source[position] === ',') {
            position++;
            maximum = source[position] === '}' ? minimum + 1 : count();
          }
          if (source[position++] !== '}') refuse();
          repeats += maximum;
          if (repeats > MAX_EXPANSION) refuse();
          copies = Math.max(1, maximum);
        }
        cost = (cost + 1) * copies;
        if (source[position] === '?') position++; // Lazy quantifiers have the same structural cost.
      }
      size += cost;
      if (size > MAX_EXPANSION) refuse();
    }
    return size;
  };
  try {
    expression(0);
    return position === source.length;
  } catch {
    return false;
  }
}

/** The compiler and release validator's sole pattern safety authority. No proof cache. */
export function safePattern(pattern: unknown): boolean {
  if (typeof pattern !== 'string' || pattern.length > 256) return false;
  try {
    new RegExp(pattern, 'u');
    if (!admitted(pattern)) return false;
    const result = checkSync(pattern, 'u', {
      // In pinned recheck 4.5.0, explicit `automaton` bypasses these three
      // structural limits. `auto` enforces them during graph construction.
      checker: 'auto',
      maxPatternSize: 257,
      maxRepeatCount: MAX_EXPANSION + 1,
      maxNFASize: MAX_TRANSITIONS,
      timeout: null,
      recallTimeout: -1, // Structural verdict only; never execute an attack string.
      logger(message) {
        // In the pinned browser checker, exceeding a graph/repetition limit logs
        // `auto:` *before* throwing Unsupported and entering its fuzz fallback.
        // Throw a JS error here instead: it cannot trigger that fallback. Other
        // unsupported syntax can reach FuzzProgram compilation, bounded by the
        // same admission limits; refuse its first log, before seeding/execution.
        if (!['parse:', 'automaton:', 'recall:'].some((stage) => message.startsWith(stage))) {
          throw new Error('Pattern requires analysis outside the structural budget');
        }
      },
    });
    return result.status === 'safe' && result.checker === 'automaton';
  } catch {
    return false;
  }
}
