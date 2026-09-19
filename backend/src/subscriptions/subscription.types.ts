import { BillingTerm } from '../catalog/catalog.constants';
import { ChangeRule, ChangeRuleKey, RuleOverride } from '../policy/policy.types';

export interface AddOnRequest {
  code: string;
  quantity: number;
}

/** What the customer wants the subscription to look like after the change. */
export interface DesiredState {
  planCode: string;
  term: BillingTerm;
  screens: number;
  addOns: AddOnRequest[];
}

export interface ChangeClassification {
  ruleKey: ChangeRuleKey | null;
  direction: 'upgrade' | 'downgrade' | 'none';
  changes: string[];
  monthlyValueBefore: number;
  monthlyValueAfter: number;
  /** the term in force before this change, needed to value what is given up */
  currentTerm?: BillingTerm;
  /** set when the change moves between two tiers of the same add-on */
  tierSwitch?: { family: string; fromCode: string; toCode: string } | null;
  /** the add-on family involved, used to look up per-add-on rule overrides */
  family?: string;
}

export interface ChangeExplanation {
  ruleKey: ChangeRuleKey | null;
  rule: ChangeRule | null;
  classification: ChangeClassification;
  stripeCall: string;
  stripeParams: Record<string, any>;
  humanSummary: string[];
}

export interface ChangeRequest extends DesiredState {
  /** one-off overrides of the policy rule, for "what if" testing */
  overrides?: RuleOverride;
  /** skip the policy and force a specific rule key (demo tooling) */
  forceRuleKey?: ChangeRuleKey;
  /**
   * Explicitly start (or skip) a trial on a brand-new subscription.
   * Omit to let the billing policy decide.
   */
  withTrial?: boolean;
  /**
   * How much of a metered add-on's allowance has been consumed this period.
   * The billing engine cannot know this — it belongs to the service that meters
   * usage — so it is supplied per request and used to price the unused part
   * when switching tiers.
   */
  quotaUsed?: number;
}

/**
 * A move on a usage-priced add-on line. Tier and quantity travel together
 * because either one changes what allowance is held and what it cost, and
 * MODEL V5 settles both through the same flow (row 8).
 */
export interface UsageChange {
  from: import('../catalog/catalog.schema').CatalogItemDocument | null;
  to: import('../catalog/catalog.schema').CatalogItemDocument | null;
  fromQuantity: number;
  toQuantity: number;
}
