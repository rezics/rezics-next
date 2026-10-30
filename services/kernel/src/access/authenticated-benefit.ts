import type { AuthoritativeTime } from '../command/command.ts';

export type ContentEditionBenefit = Readonly<{
  kind: 'content-edition'; resourceType: 'content.edition';
  resource: Readonly<{route:number;id:string}>;
  version: Readonly<{revisionId:string;sha256:string}>;
  action: 'edition:read';
}>;
declare const buyerFact: unique symbol;
export type ContentEditionBuyerFact = {readonly [buyerFact]:true};
export type ContentEditionBuyerFactInput = Readonly<{
  benefit: ContentEditionBenefit; buyerAccountId:string;
  entitlementId:string; entitlementRevision:number;
  time:AuthoritativeTime; deadline:number;
}>;
/** Internal native issuer; Commerce supplies validated current entitlement bindings. */
export function createContentEditionBuyerFact(input:ContentEditionBuyerFactInput):ContentEditionBuyerFact {
  void input;
  throw new TypeError('Native buyer fact issuer is not installed yet');
}
export type ContentEditionBuyerFactReader = (input:Readonly<{
  benefit:ContentEditionBenefit; buyerAccountId:string;
  time:AuthoritativeTime; deadline:number;
}>)=>Promise<ContentEditionBuyerFact|null>;
