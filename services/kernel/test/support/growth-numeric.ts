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

/** Per-point repetition arrays admitted by classification and calibration, covering harness sampling (at most 15). */
export const GROWTH_REPETITION_CAPACITY = 256;

/** Min and max without spreading into an engine argument list. */
export function numericExtent(values: readonly number[]): Readonly<{ min: number; max: number }> {
  let min = values[0]!;
  let max = values[0]!;
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index]!;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

function finiteResult(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new TypeError(`${label} is not representable as a finite number`);
  return value;
}

/** Arithmetic range failure while evaluating an approximate growth model. */
export class GrowthModelArithmeticError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'GrowthModelArithmeticError';
  }
}

function modelFiniteResult(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new GrowthModelArithmeticError(`${label} is not representable as a finite number`);
  return value;
}

function requireModelOperands(values: readonly number[], label: string): void {
  for (const value of values)
    if (!Number.isFinite(value)) throw new GrowthModelArithmeticError(`${label} requires finite operands`);
}

/** IEEE-754 rounded addition for approximate model calculations. */
export function modelAdd(left: number, right: number, label: string): number {
  requireModelOperands([left, right], label);
  return modelFiniteResult(left + right, label);
}

/** IEEE-754 rounded subtraction for approximate model calculations. */
export function modelSubtract(left: number, right: number, label: string): number {
  requireModelOperands([left, right], label);
  return modelFiniteResult(left - right, label);
}

/** IEEE-754 rounded multiplication; an underflowed derived term may round to zero. */
export function modelMultiply(left: number, right: number, label: string): number {
  requireModelOperands([left, right], label);
  return modelFiniteResult(left * right, label);
}

/** IEEE-754 rounded division; an underflowed derived ratio may round to zero. */
export function modelDivide(numerator: number, denominator: number, label: string): number {
  requireModelOperands([numerator, denominator], label);
  if (denominator === 0) throw new GrowthModelArithmeticError(`${label} cannot divide by zero`);
  return modelFiniteResult(numerator / denominator, label);
}

/** Compensated sum for short, normalized model terms. */
export function modelSum(values: readonly number[], label: string): number {
  let sum = 0;
  let correction = 0;
  for (const value of values) {
    requireModelOperands([value], label);
    const next = modelFiniteResult(sum + value, label);
    const residual = Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum;
    correction = modelAdd(correction, residual, `${label} correction`);
    sum = next;
  }
  return modelAdd(sum, correction, label);
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
  return multiplyDivide(a, b, c, label, false);
}

/** Computes a*b/c with IEEE-754 rounding for approximate model calculations. */
export function modelMultiplyDivide(a: number, b: number, c: number, label: string): number {
  return multiplyDivide(a, b, c, label, true);
}

function multiplyDivide(a: number, b: number, c: number, label: string, allowUnderflow: boolean): number {
  for (const [operand, value] of [
    ['a', a],
    ['b', b],
    ['c', c],
  ] as const) {
    if (allowUnderflow) {
      if (!Number.isFinite(value))
        throw new GrowthModelArithmeticError(`${label} operand ${operand} must be a finite number`);
    } else requireFiniteNumber(value, `${label} operand ${operand}`);
  }
  if (c === 0) {
    if (allowUnderflow) throw new GrowthModelArithmeticError(`${label} cannot divide by zero`);
    throw new TypeError(`${label} cannot divide by zero`);
  }
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
  if (exponent > 1023) {
    if (allowUnderflow) throw new GrowthModelArithmeticError(`${label} is not representable as a finite number`);
    throw new TypeError(`${label} is not representable as a finite number`);
  }
  if (allowUnderflow && exponent < -1075) return (a < 0 !== b < 0) !== c < 0 ? -0 : 0;
  if (allowUnderflow && exponent === -1075) {
    const result = mantissa > 1 ? Number.MIN_VALUE : 0;
    return (a < 0 !== b < 0) !== c < 0 ? -result : result;
  }
  if (!allowUnderflow && exponent < -1074) throw new TypeError(`${label} is too small to represent without underflow`);
  const result = allowUnderflow
    ? modelFiniteResult(mantissa * 2 ** exponent, label)
    : finiteResult(mantissa * 2 ** exponent, label);
  if (!allowUnderflow && result === 0) throw new TypeError(`${label} is too small to represent without underflow`);
  const isNegative = (a < 0 !== b < 0) !== c < 0;
  return isNegative ? -result : result;
}

export function sumFinite(values: readonly number[], label: string): number {
  requireDenseArray(values, label);
  return values.reduce((sum, value) => checkedAdd(sum, value, label), 0);
}
