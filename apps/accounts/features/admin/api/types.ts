// The operator panel's data, derived from the Account service's own route
// schemas: a changed response fails this app's type-check, not a page.
import type { AccountApp } from '@rezics/account/app';

type Routes = AccountApp['~Routes']['api']['account'];
type Admin = Routes['admin'];
type Ok<Route> = Route extends { response: { 200: infer Body } } ? Body : never;
type UserRoutes = Admin['users'][':userId'];

export type AdminMe = Ok<Admin['me']['get']>;
export type OperatorRole = NonNullable<AdminMe['role']>;
export type Overview = Ok<Admin['overview']['get']>;
export type QueueUser = Overview['suspended']['users'][number];
export type Directory = Ok<Admin['users']['get']>;
export type DirectoryParams = NonNullable<Admin['users']['get']['query']>;
export type AdminUser = Directory['items'][number];
export type UserStatus = AdminUser['status'];
export type UserDetail = Ok<UserRoutes['get']>;
export type SessionPage = Ok<UserRoutes['sessions']['get']>;
export type AppPage = Ok<UserRoutes['apps']['get']>;
export type ActivityPage = Ok<UserRoutes['security-activity']['get']>;
export type AuditPage = Ok<Admin['audit']['get']>;
export type AuditEntry = AuditPage['items'][number];
export type AuditParams = NonNullable<Admin['audit']['get']['query']>;
export type Job = Ok<Admin['bulk-actions'][':jobId']['get']>;
export type JobSummary = Overview['jobs'][number];
export type Operators = Ok<Admin['operators']['get']>;
export type OperatorEntry = Operators['items'][number];
export type Preferences = Ok<Admin['preferences']['get']>;
export type PreferenceChange = Admin['preferences']['post']['body'];
export type DirectoryColumn = NonNullable<Preferences['columns']>[number];
export type SavedView = Preferences['views'][number];
export type ClientPage = Ok<Admin['clients']['get']>;
export type AdminClientEntry = ClientPage['items'][number];
export type ActionBody = UserRoutes['actions']['post']['body'];
export type AdminAction = ActionBody['action'];
export type ReasonCode = NonNullable<ActionBody['reasonCode']>;
export type BulkBody = Admin['bulk-actions']['post']['body'];
export type BulkAction = BulkBody['action'];
export type ClientActionBody = Admin['clients'][':clientId']['actions']['post']['body'];
export type InstallationChange = Routes['installation-changes']['post']['body'];
export type Installation = Ok<Routes['installation-changes']['post']>;
export type CommandResult = Ok<UserRoutes['actions']['post']>;
/** Stable error codes the Account service returns for every admin route. */
export type AccountErrorCode = Admin['me']['get']['response'][403]['error'];
