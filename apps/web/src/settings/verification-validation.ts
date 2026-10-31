export type VerificationDraftFields = {
  subject: string;
  statement: string;
  links: { label: string; url: string }[];
};

export type VerificationIssue = {
  field: 'subject' | 'statement' | 'links' | 'label' | 'url';
  index?: number;
  code:
    | 'subject-required'
    | 'statement-required'
    | 'statement-limit'
    | 'links-limit'
    | 'label-required'
    | 'label-limit'
    | 'url-required'
    | 'url-limit'
    | 'url-https';
};

export function verificationCharacterCount(value: string): number {
  return Array.from(value).length;
}

/** Native draft-field bounds, plus the Web's meaningful nonblank text requirements. Never changes input. */
export function validateVerificationDraft(input: VerificationDraftFields): VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  if (!input.subject) issues.push({ field: 'subject', code: 'subject-required' });
  if (!input.statement.trim()) issues.push({ field: 'statement', code: 'statement-required' });
  else if (verificationCharacterCount(input.statement) > 2000)
    issues.push({ field: 'statement', code: 'statement-limit' });
  if (input.links.length > 5) {
    issues.push({ field: 'links', code: 'links-limit' });
    return issues;
  }
  input.links.forEach((link, index) => {
    if (!link.label.trim()) issues.push({ field: 'label', index, code: 'label-required' });
    else if (verificationCharacterCount(link.label) > 64) issues.push({ field: 'label', index, code: 'label-limit' });
    if (!link.url) issues.push({ field: 'url', index, code: 'url-required' });
    else if (verificationCharacterCount(link.url) > 2048) issues.push({ field: 'url', index, code: 'url-limit' });
    else {
      // Match access/agent-verification.ts on the original string, before WHATWG URL parsing can repair it.
      let valid = /^https:\/\/[^/@\s]+(?:[/?#]|$)/i.test(link.url) && !/[\u0000-\u0020\u007f]/.test(link.url);
      try {
        const parsed = new URL(link.url);
        valid &&= parsed.protocol === 'https:' && parsed.hostname.length > 0 && !parsed.username && !parsed.password;
      } catch {
        valid = false;
      }
      if (!valid) issues.push({ field: 'url', index, code: 'url-https' });
    }
  });
  return issues;
}
