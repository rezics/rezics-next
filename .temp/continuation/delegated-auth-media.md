# Delegated Auth and SessionMedia acceptance

goal: web
manager: web
kind: interface

Finish the delegated agent/principal part of Auth pages and shared BFF media acceptance after Accounts supplies
its native delegated-client/assignment fixture binding. Read apps/auth/README.md (Consent), docs/goals/accounts.md,
docs/goals/web.capabilities.md (Auth pages and session transport), specs/web-personal-driver.ts and
apps/web/tests/native/web-personal-driver.ts. The existing private native Auth fixture supports page mounting and
automated-account provisioning; it supplies no third-party delegated client/assignment issuance binding. Its operated
human session is not a delegated agent/principal proof and must not be used as one.

Use production consent pages and native issuance, explicit principal-created assignment and resource grants. Extend
the existing personal driver with the real delegated context. Verify reviewed subject/client/requested scopes, both
agent and principal current authority, and reserve/upload/native completion/download through shared Web BFF using
that context's real cookies and rendered CSRF token. Refuse stale consent, revoked assignment and either suspended
identity. Do not inject bearer credentials into Web or fabricate a session, approval or positive response.

Existing source implements draft recovery, exact unknown-command inspection, native security/step-up and
preferences/deletion entry, plus media Alice/Bob/anonymous/revoked/suspended composed cases. Native/browser
execution and promoted acceptance remain controller-owned. Keep physical stack custody in the existing binding.
