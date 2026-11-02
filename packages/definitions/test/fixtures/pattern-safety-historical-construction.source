/// <reference path="./recheck.d.ts" />
import { readFileSync } from 'node:fs';
import { createContext, Script } from 'node:vm';

export const MAX_ANALYSIS_STEPS = 8192;
// Admission bounds the *expanded* expression before recheck allocates its NFA.
// Counts include nested multiplication, not just the spelling of {n}. Saturate
// by refusing immediately, before any expansion or integer overflow is possible.
const MAX_EXPANSION = 128;
const MAX_DEPTH = 16;
const MAX_COUNT = 64;
const MAX_TRANSITIONS = 1024;

function admitted(source: string): boolean {
  let position = 0;
  let repeats = 0;
  const refuse = (): never => {
    throw new Error('Pattern structure exceeds the analysis profile');
  };
  const escape = () => {
    const char = source[position++];
    // Backreferences and Unicode properties are outside this structural profile.
    if (char === undefined || /[1-9kpP]/u.test(char)) refuse();
    if ((char === 'u' || char === 'x') && source[position] === '{') {
      while (position < source.length && source[position++] !== '}') {
        /* One code point. */
      }
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
      if (source[position] === '|') {
        position++;
        size++;
        continue;
      }
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

/**
 * Prove the grammar (?:^F S* : T* $)(?![\s\S]), optionally inside ^(?:1|...)$.
 * F is an ASCII letter class, S an ASCII scheme class (no colon), and T one
 * native Unicode character class. All punctuation/assertions must be consumed.
 *
 * With only the u flag, ^ fixes one start. F consumes one code point; S cannot
 * cross the colon, so there is at most one entry into T. Each of S* and T* can
 * scan/backtrack at most the input length, and every suffix assertion is O(1).
 * The optional literal branch starts with 1, disjoint from F. Thus matching is
 * O(n), including rejection, without automaton construction or execution here.
 *
 * The recognizer scans at most the already-admitted 256 source characters.
 * Range checks use fixed ASCII intervals, never expansion or input matching.
 */
function iriCompositionProof(source: string): boolean {
  let position = 0;
  const take = (token: string) => {
    if (!source.startsWith(token, position)) return false;
    position += token.length;
    return true;
  };
  const asciiClass = (scheme: boolean) => {
    if (!take('[')) return false;
    const start = position;
    while (position < source.length && source[position] !== ']') {
      const low = source.charCodeAt(position++);
      let high = low;
      if (source[position] === '-' && source[position + 1] !== ']') {
        position++;
        high = source.charCodeAt(position++);
      }
      // Only literal ASCII intervals; no escapes, negation or class extensions.
      if (
        low > high ||
        !(
          (low >= 65 && high <= 90) ||
          (low >= 97 && high <= 122) ||
          (scheme && ((low >= 48 && high <= 57) || (low === high && [43, 45, 46].includes(low))))
        )
      )
        return false;
    }
    return position > start && take(']');
  };
  const tailClass = () => {
    if (!take('[')) return false;
    while (position < source.length) {
      const char = source[position++];
      if (char === '\\') position++;
      else if (char === ']') return true;
    }
    return false;
  };
  const wildcard = take('^(?:1|');
  return (
    take('(?:^') &&
    asciiClass(false) &&
    asciiClass(true) &&
    take('*:') &&
    tailClass() &&
    take('*$)(?![\\s\\S])') &&
    (!wildcard || take(')$')) &&
    position === source.length
  );
}

const checkerPath = import.meta.resolve('recheck/lib/browser.js');
// The pinned browser checker implements Scala.js nanoTime with performance.now.
// Keep the counter and all checkpoint callbacks in the checker's own realm:
// no host clock is patched, and crossing realms cannot add work per checkpoint.
const context = createContext({ module: { exports: {} } });
new Script(
  `
  let rezicsPatternSteps = 0;
  globalThis.performance = { now() {
    if (++rezicsPatternSteps > ${MAX_ANALYSIS_STEPS}) throw new Error('Pattern analysis operation budget exhausted');
    return rezicsPatternSteps * 3000 / ${MAX_ANALYSIS_STEPS};
  } };
` + readFileSync(new URL(checkerPath), 'utf8'),
  { filename: checkerPath },
).runInContext(context);
// The Scala.js parameter decoder requires objects/functions from its own realm.
// Compile a fixed wrapper; the untrusted pattern is passed only as a string argument.
const checkPattern = new Script(`(pattern) => {
  rezicsPatternSteps = 0;
  try {
    const result = module.exports.checkSync(pattern, 'u', {
      // Explicit automaton mode bypasses these limits in the pinned checker.
      checker: 'auto',
      maxPatternSize: 257,
      maxRepeatCount: ${MAX_EXPANSION + 1},
      maxNFASize: ${MAX_TRANSITIONS},
      timeout: 3000,
      maxRecallStringSize: 1024,
      recallTimeout: -1,
      logger(message) {
        // Structural cap failures log before the auto/fuzz fallback. Refuse
        // these and all fuzz diagnostics before seeding or matching begins.
        if (!['parse:', 'automaton:', 'recall:'].some(stage => message.startsWith(stage))) {
          throw new Error('Pattern requires analysis outside the structural budget');
        }
      }
    });
    return { safe: result.status === 'safe' && result.checker === 'automaton', steps: rezicsPatternSteps };
  } catch {
    return { safe: false, steps: rezicsPatternSteps };
  }
}`).runInContext(context) as (pattern: string) => { safe: boolean; steps: number };

/** The compiler and release validator's sole pattern safety authority. No proof cache. */
export function analyzePattern(pattern: unknown): { safe: boolean; steps: number; proof?: 'iri-composition' } {
  if (typeof pattern !== 'string' || pattern.length > 256) return { safe: false, steps: 0 };
  try {
    new RegExp(pattern, 'u');
    if (!admitted(pattern)) return { safe: false, steps: 0 };
    // Independent structural proof, before (and never inferred from) a native
    // unknown/over-budget verdict. Zero steps means no native checkpoints ran.
    if (iriCompositionProof(pattern)) return { safe: true, steps: 0, proof: 'iri-composition' };
    return checkPattern(pattern);
  } catch {
    return { safe: false, steps: 0 };
  }
}

export function safePattern(pattern: unknown): boolean {
  return analyzePattern(pattern).safe;
}
