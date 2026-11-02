/** Shared validation and checked arithmetic for numerical growth evidence. */
export function requireFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} must be a finite number`);
}

export function requireNonNegativeFiniteNumber(value: unknown, label: string): asserts value is number {
  requireFiniteNumber(value, label);
  if (value < 0) throw new TypeError(`${label} must be non-negative`);
}

export function requireDenseArray(values: readonly unknown[], label: string): void {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  for (let index = 0; index < values.length; index += 1)
    if (!Object.hasOwn(values, index)) throw new TypeError(`${label} is missing item ${index + 1}`);
}

function finiteResult(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new TypeError(`${label} is not representable as a finite number`);
  return value;
}

export function checkedAdd(left: number, right: number, label: string): number {
  const result = finiteResult(left + right, label);
  if (right !== 0 && result === left) throw new TypeError(`${label} loses a non-zero contribution`);
  if (left !== 0 && result === right) throw new TypeError(`${label} loses a non-zero contribution`);
  return result;
}

export function checkedSubtract(left: number, right: number, label: string): number {
  const result = finiteResult(left - right, label);
  if (right !== 0 && result === left) throw new TypeError(`${label} loses a non-zero difference`);
  return result;
}

export function checkedMultiply(left: number, right: number, label: string): number {
  const result = finiteResult(left * right, label);
  if (left !== 0 && right !== 0 && result === 0)
    throw new TypeError(`${label} is too small to represent without underflow`);
  return result;
}

export function checkedDivide(numerator: number, denominator: number, label: string): number {
  if (denominator === 0) throw new TypeError(`${label} cannot divide by zero`);
  const result = finiteResult(numerator / denominator, label);
  if (numerator !== 0 && result === 0) throw new TypeError(`${label} is too small to represent without underflow`);
  return result;
}

function binaryParts(value: number): { readonly mantissa: number; readonly exponent: number } {
  const absolute = Math.abs(value);
  let exponent = Math.floor(Math.log2(absolute));
  if (exponent > 1023) exponent = 1023;
  let unit = 2 ** exponent;
  while (unit > absolute) {
    exponent -= 1;
    unit /= 2;
  }
  while (exponent < 1023 && absolute >= unit * 2) {
    exponent += 1;
    unit *= 2;
  }
  return { mantissa: absolute / unit, exponent };
}

/** Computes a*b/c without overflowing a representable final ratio in an intermediate product. */
export function checkedMultiplyDivide(a: number, b: number, c: number, label: string): number {
  for (const [operand, value] of [
    ['a', a],
    ['b', b],
    ['c', c],
  ] as const) {
    requireFiniteNumber(value, `${label} operand ${operand}`);
  }
  if (c === 0) throw new TypeError(`${label} cannot divide by zero`);
  if (a === 0 || b === 0) return 0;
  const left = binaryParts(a);
  const right = binaryParts(b);
  const divisor = binaryParts(c);
  let mantissa = (left.mantissa * right.mantissa) / divisor.mantissa;
  let exponent = left.exponent + right.exponent - divisor.exponent;
  while (mantissa >= 2) {
    mantissa /= 2;
    exponent += 1;
  }
  while (mantissa < 1) {
    mantissa *= 2;
    exponent -= 1;
  }
  if (exponent > 1023) throw new TypeError(`${label} is not representable as a finite number`);
  if (exponent < -1074) throw new TypeError(`${label} is too small to represent without underflow`);
  const result = finiteResult(mantissa * 2 ** exponent, label);
  if (result === 0) throw new TypeError(`${label} is too small to represent without underflow`);
  const isNegative = (a < 0 !== b < 0) !== c < 0;
  return isNegative ? -result : result;
}

export function sumFinite(values: readonly number[], label: string): number {
  requireDenseArray(values, label);
  return values.reduce((sum, value) => checkedAdd(sum, value, label), 0);
}
