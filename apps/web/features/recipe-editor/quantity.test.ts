import { expect, test } from 'bun:test';
import { amountText, leadingAmount, typedAmount, wholeNumber } from './quantity.ts';

test('a leading quantity keeps its written form and an exact reduced value', () => {
  expect(leadingAmount('1½ cups flour')).toEqual({ lexical: '1½', amount: { numerator: 3, denominator: 2 }, rest: 'cups flour' });
  expect(leadingAmount('1 1/2 cups flour')).toMatchObject({ lexical: '1 1/2', amount: { numerator: 3, denominator: 2 }, rest: 'cups flour' });
  expect(leadingAmount('1 ½ cups')).toMatchObject({ lexical: '1 ½', amount: { numerator: 3, denominator: 2 } });
  expect(leadingAmount('¾ tsp salt')).toMatchObject({ lexical: '¾', amount: { numerator: 3, denominator: 4 }, rest: 'tsp salt' });
  expect(leadingAmount('0.75 l milk')).toMatchObject({ lexical: '0.75', amount: { numerator: 3, denominator: 4 } });
  expect(leadingAmount('1,5 EL Öl')).toMatchObject({ lexical: '1,5', amount: { numerator: 3, denominator: 2 }, rest: 'EL Öl' });
  expect(leadingAmount('250g butter')).toMatchObject({ lexical: '250', amount: { numerator: 250, denominator: 1 }, rest: 'g butter' });
  expect(leadingAmount('4/8 cup')?.amount).toEqual({ numerator: 1, denominator: 2 });
});

test('a range keeps both ends and only an ascending pair is a range', () => {
  expect(leadingAmount('2-3 cloves garlic')).toMatchObject({ lexical: '2-3', amount: { numerator: 2, denominator: 1 },
    amountUpper: { numerator: 3, denominator: 1 }, rest: 'cloves garlic' });
  expect(leadingAmount('2 to 3 cups')).toMatchObject({ lexical: '2 to 3', amountUpper: { numerator: 3, denominator: 1 } });
  expect(leadingAmount('1-1/2 cups')).toMatchObject({ lexical: '1-1/2', amount: { numerator: 3, denominator: 2 } });
  expect(leadingAmount('3-2 cups')?.amountUpper).toBeUndefined();
});

test('text that does not start with a quantity has none, and oversized values are refused', () => {
  expect(leadingAmount('salt to taste')).toBeNull();
  expect(leadingAmount('a pinch of salt')).toBeNull();
  expect(leadingAmount('9999999999999 cups')).toBeNull();
  expect(leadingAmount('1/0 cup')).toBeNull();
});

test('field values: whole numbers, typed amounts and their text', () => {
  expect(wholeNumber(' 45 ')).toEqual({ numerator: 45, denominator: 1 });
  expect(wholeNumber('4.5')).toBeNull();
  expect(typedAmount('1½')).toEqual({ numerator: 3, denominator: 2 });
  expect(typedAmount('2-3')).toBeNull();
  expect(amountText({ numerator: 3, denominator: 2 })).toBe('1 1/2');
  expect(amountText({ numerator: 4, denominator: 1 })).toBe('4');
});
