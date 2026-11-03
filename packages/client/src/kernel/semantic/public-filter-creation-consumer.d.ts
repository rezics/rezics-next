/** The ordinary outbox checkpoint pins the original creation/change window.
 * It is retained until native Source/copy retirement, never advanced by a query.
 */
export declare function publicFilterCreationConsumer(bootstrap: string): string;
