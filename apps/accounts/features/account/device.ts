export interface DeviceDescription { browser: string | null; os: string | null;
  kind: 'phone' | 'tablet' | 'computer' | 'unknown' }

const browsers: [RegExp, string][] = [[/\bEdg(?:e|A|iOS)?\//, 'Edge'], [/\bOPR\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'], [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\b(?:Chrome|CriOS)\//, 'Chrome'], [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari']];
const systems: [RegExp, string][] = [[/\biPhone\b/, 'iOS'], [/\biPad\b/, 'iPadOS'],
  [/\bAndroid\b/, 'Android'], [/\bCrOS\b/, 'ChromeOS'], [/\bWindows NT\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'], [/\bLinux\b/, 'Linux']];

/** A short, human description of the browser behind a session's User-Agent. */
export function describeUserAgent(userAgent: string | null): DeviceDescription {
  if (!userAgent) return { browser: null, os: null, kind: 'unknown' };
  const browser = browsers.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null;
  const os = systems.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null;
  const kind = /\biPad\b|\bTablet\b|Android(?!.*Mobile)/.test(userAgent) ? 'tablet'
    : /\bMobile\b|\biPhone\b/.test(userAgent) ? 'phone' : os ? 'computer' : 'unknown';
  return { browser, os, kind };
}
