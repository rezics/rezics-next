const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

export function timeText(createdAt: string, now: string, locale: string): string {
  const difference = new Date(createdAt).getTime() - new Date(now).getTime();
  const distance = Math.abs(difference);
  if (distance <= 7 * day) {
    const [unit, milliseconds] =
      distance < minute
        ? (['second', 1_000] as const)
        : distance < hour
          ? (['minute', minute] as const)
          : distance < day
            ? (['hour', hour] as const)
            : (['day', day] as const);
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(Math.round(difference / milliseconds), unit);
  }
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(createdAt));
}

export function fullDateTime(createdAt: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'long', timeZone: 'UTC' }).format(
    new Date(createdAt),
  );
}
