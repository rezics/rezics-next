import type { SubjectVisitNavigationPort } from './semantic-render-port';

let binding: SubjectVisitNavigationPort | undefined;

/** Installed with the full Subject render port by the existing Web composition boundary. */
export function installSubjectRenderBinding(port: SubjectVisitNavigationPort): void {
  binding = port;
}

export function subjectRenderBinding(): SubjectVisitNavigationPort {
  if (!binding) throw new Error('Subject return navigation binding is not installed');
  return binding;
}
