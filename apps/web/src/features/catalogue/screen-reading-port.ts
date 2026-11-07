import type { ComponentType, ReactNode } from 'react';
import type { PageLink, Related, Snak } from '../pages/shared';

export type ScreenPageValueProps = {
  snak: Snak & { id?: string };
  related: Related;
  locale: string;
  subject?: string;
  documents?: unknown;
  documentUnavailable?: ReactNode;
  link?: PageLink;
};

export type ScreenSpoilerGateProps = {
  label: string;
  hideLabel?: string;
  unmountOnHide?: boolean;
  children: ReactNode;
};

export type ScreenVisitReturn = (value: unknown, locale?: string) => string | undefined;

export type ScreenSubjectHref = (subject: { id: string; label: string }, locale: string) => { href: string };

/** Page rendering and return admission the Screen reader consumes; Search binds the live implementations. */
export type ScreenReadingPort = {
  PageValue: ComponentType<ScreenPageValueProps>;
  SpoilerGate: ComponentType<ScreenSpoilerGateProps>;
  visitReturn: ScreenVisitReturn;
  subjectHref: ScreenSubjectHref;
};
