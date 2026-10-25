-- migrate:up
-- Native client/consent models extend the existing sole authorities.
ALTER TABLE auth_client ADD COLUMN id text GENERATED ALWAYS AS (client_id) STORED UNIQUE;
ALTER TABLE auth_consent ADD COLUMN id text NOT NULL DEFAULT gen_random_uuid()::text UNIQUE;
alter table "auth_client" add column "clientSecret" text;

alter table "auth_client" add column "clientDiscoveryId" text;

alter table "auth_client" add column "disabled" boolean default false;

alter table "auth_client" add column "enableEndSession" boolean;

alter table "auth_client" add column "subjectType" text;

alter table "auth_client" add column "sectorIdentifier" text;

alter table "auth_client" add column "clientCredentialsScopes" jsonb;

alter table "auth_client" add column "userId" text references "user" ("id") on delete cascade;

alter table "auth_client" add column "createdAt" timestamptz;

alter table "auth_client" add column "updatedAt" timestamptz;

alter table "auth_client" add column "name" text;

alter table "auth_client" add column "uri" text;

alter table "auth_client" add column "icon" text;

alter table "auth_client" add column "contacts" jsonb;

alter table "auth_client" add column "tos" text;

alter table "auth_client" add column "policy" text;

alter table "auth_client" add column "softwareId" text;

alter table "auth_client" add column "softwareVersion" text;

alter table "auth_client" add column "softwareStatement" text;

alter table "auth_client" add column "redirectUris" jsonb not null default '[]'::jsonb;

alter table "auth_client" add column "postLogoutRedirectUris" jsonb;

alter table "auth_client" add column "backchannelLogoutUri" text;

alter table "auth_client" add column "backchannelLogoutSessionRequired" boolean;

alter table "auth_client" add column "frontchannelLogoutUri" text;

alter table "auth_client" add column "frontchannelLogoutSessionRequired" boolean;

alter table "auth_client" add column "tokenEndpointAuthMethod" text;

alter table "auth_client" add column "applicationType" text;

alter table "auth_client" add column "jwks" text;

alter table "auth_client" add column "jwksUri" text;

alter table "auth_client" add column "grantTypes" jsonb;

alter table "auth_client" add column "responseTypes" jsonb;

alter table "auth_client" add column "requirePKCE" boolean;

alter table "auth_client" add column "dpopBoundAccessTokens" boolean default false;

alter table "auth_client" add column "referenceId" text;

alter table "auth_client" add column "metadata" jsonb;

alter table "auth_consent" add column "referenceId" text;

alter table "auth_consent" add column "resources" jsonb;

alter table "auth_consent" add column "requestedUserInfoClaims" jsonb;

alter table "auth_consent" add column "createdAt" timestamptz not null default CURRENT_TIMESTAMP;

alter table "auth_consent" add column "updatedAt" timestamptz not null default CURRENT_TIMESTAMP;

create table "jwks" ("id" text not null primary key, "publicKey" text not null, "privateKey" text not null, "createdAt" timestamptz not null, "expiresAt" timestamptz, "alg" text, "crv" text);

create table "oauthResource" ("id" text not null primary key, "identifier" text not null unique, "name" text not null, "accessTokenTtl" integer, "refreshTokenTtl" integer, "signingAlgorithm" text, "signingKeyId" text, "allowedScopes" jsonb, "customClaims" jsonb, "dpopBoundAccessTokensRequired" boolean, "disabled" boolean, "createdAt" timestamptz, "updatedAt" timestamptz, "policyVersion" integer, "metadata" jsonb);

create table "oauthClientResource" ("id" text not null primary key, "clientId" text not null references "auth_client" ("client_id") on delete cascade, "resourceId" text not null references "oauthResource" ("identifier") on delete cascade, "metadata" jsonb, "createdAt" timestamptz);

create table "oauthRefreshFamily" ("id" text not null primary key, "clientId" text not null, "revoked" boolean not null, "sequence" integer not null, "expiresAt" timestamptz not null);

create table "oauthRefreshToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "auth_client" ("client_id") on delete cascade, "sessionId" text, "userId" text not null references "user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "expiresAt" timestamptz not null, "createdAt" timestamptz not null, "revoked" timestamptz, "rotatedAt" timestamptz, "rotationReplayResponse" text, "rotationReplayExpiresAt" timestamptz, "authTime" timestamptz, "acr" text, "amr" jsonb, "confirmation" jsonb, "scopes" jsonb not null);

create table "oauthAccessToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "auth_client" ("client_id") on delete cascade, "sessionId" text, "userId" text references "user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "refreshId" text references "oauthRefreshToken" ("id") on delete cascade, "expiresAt" timestamptz not null, "createdAt" timestamptz not null, "revoked" timestamptz, "confirmation" jsonb, "scopes" jsonb not null);

create table "oauthClientAssertion" ("id" text not null primary key, "expiresAt" timestamptz not null);

create index "auth_client_userId_idx" on "auth_client" ("userId");

create index "oauthClientResource_clientId_idx" on "oauthClientResource" ("clientId");

create index "oauthClientResource_resourceId_idx" on "oauthClientResource" ("resourceId");

create index "oauthRefreshFamily_expiresAt_idx" on "oauthRefreshFamily" ("expiresAt");

create index "oauthRefreshToken_clientId_idx" on "oauthRefreshToken" ("clientId");

create index "oauthRefreshToken_sessionId_idx" on "oauthRefreshToken" ("sessionId");

create index "oauthRefreshToken_userId_idx" on "oauthRefreshToken" ("userId");

create index "oauthRefreshToken_authorizationCodeId_idx" on "oauthRefreshToken" ("authorizationCodeId");

create index "oauthAccessToken_clientId_idx" on "oauthAccessToken" ("clientId");

create index "oauthAccessToken_sessionId_idx" on "oauthAccessToken" ("sessionId");

create index "oauthAccessToken_userId_idx" on "oauthAccessToken" ("userId");

create index "oauthAccessToken_authorizationCodeId_idx" on "oauthAccessToken" ("authorizationCodeId");

create index "oauthAccessToken_refreshId_idx" on "oauthAccessToken" ("refreshId");

create unique index "oauthClientResource_clientId_resourceId_uidx" on "oauthClientResource" ("clientId", "resourceId");
CREATE INDEX oauth_refresh_expiry ON "oauthRefreshToken" ("expiresAt",id);
CREATE INDEX oauth_access_expiry ON "oauthAccessToken" ("expiresAt",id);
CREATE INDEX oauth_assertion_expiry ON "oauthClientAssertion" ("expiresAt",id);
CREATE TABLE auth_recent_oidc_session (
  session_id text PRIMARY KEY,
  account_id text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX auth_recent_oidc_expiry ON auth_recent_oidc_session (expires_at,session_id);

-- migrate:down
-- Forward-only: native bearer state and registry extensions cannot be rolled back safely.
SELECT 1;
