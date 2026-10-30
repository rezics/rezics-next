const currencies = new Set(Intl.supportedValuesOf('currency'));

/** Format native minor units without rounding a safe integer through floating-point major units. */
export function formatMinorAmount(locale: string, currency: string, minor: number): string | null {
  if (!Number.isSafeInteger(minor) || !/^[a-z]{3}$/i.test(currency)) return null;
  const code = currency.toUpperCase();
  // NumberFormat accepts arbitrary three-letter codes and guesses two decimals for unknown currencies.
  if (!currencies.has(code)) return null;
  try {
    const formatter = new Intl.NumberFormat(locale, { style: 'currency', currency: code });
    const { minimumFractionDigits, maximumFractionDigits: digits } = formatter.resolvedOptions();
    if (
      digits === undefined ||
      !Number.isInteger(digits) ||
      digits < 0 ||
      digits > 20 ||
      minimumFractionDigits !== digits
    )
      return null;

    const amount = BigInt(minor);
    const scale = 10n ** BigInt(digits);
    const whole = amount / scale;
    const remainder = (amount < 0n ? -amount : amount) % scale;
    const fraction = digits
      ? new Intl.NumberFormat(locale, {
          useGrouping: false,
          minimumIntegerDigits: digits,
          maximumFractionDigits: 0,
        }).format(remainder)
      : '';
    // A negative subunit amount still needs a minus sign when its integral part is zero.
    return formatter
      .formatToParts(whole === 0n && (minor < 0 || Object.is(minor, -0)) ? -0 : whole)
      .map((part) => (part.type === 'fraction' ? fraction : part.value))
      .join('');
  } catch {
    return null;
  }
}
