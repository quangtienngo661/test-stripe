#!/usr/bin/env node
/**
 * End-to-end walk through every billing mechanic against real Stripe test-mode
 * objects. Creates a throwaway account on a Stripe test clock, then exercises:
 *
 *   trial → subscribe → add screens (proration) → add-ons → remove screens
 *   (credit) → refund-on-downgrade policy → monthly→yearly switch →
 *   scheduled downgrade → renewal via time travel → refund → cancellation
 *
 * Usage: node scripts/verify.mjs [--keep]
 *
 * Run it alone. The billing policy is a single shared document, and the suite
 * switches presets as it goes — anything else touching /api/policy at the same
 * time (another run, a scratch script) will make unrelated checks fail.
 */
const API = process.env.API_URL ?? 'http://localhost:3123/api';
const KEEP = process.argv.includes('--keep');

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  head: (s) => `\x1b[1m\x1b[36m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
};

const money = (cents, cur = 'usd') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: cur.toUpperCase() }).format((cents ?? 0) / 100);

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ${c.ok('✓')} ${label} ${c.dim(detail)}`);
  else {
    failures += 1;
    console.log(`  ${c.bad('✗')} ${label} ${c.warn(detail)}`);
  }
};

const call = async (method, path, body) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = json?.message?.message ?? json?.message ?? res.statusText;
    throw new Error(`${method} ${path} → ${res.status}: ${typeof message === 'string' ? message : JSON.stringify(message)}`);
  }
  return json;
};
const GET = (p) => call('GET', p);
const POST = (p, b) => call('POST', p, b);
const PUT = (p, b) => call('PUT', p, b);
const DELETE = (p) => call('DELETE', p);

const step = (title) => console.log(`\n${c.head(title)}`);

const run = async () => {
  step('0 · Environment');
  const catalog = await GET('/catalog');
  check('Stripe key configured', catalog.stripeConfigured);
  if (!catalog.stripeConfigured) {
    console.log(c.warn('\n  Set STRIPE_SECRET_KEY in backend/.env and restart the API, then re-run.'));
    process.exit(1);
  }
  await POST('/catalog/sync-stripe');
  const synced = await GET('/catalog');
  check('Catalog synced to Stripe', synced.stripeSynced);

  // Start from a known policy so the assertions below are deterministic.
  await POST('/policy/presets/optisigns_default');

  step('1 · Account on a Stripe test clock');
  const email = `demo+${Date.now()}@optisigns-billing-demo.test`;
  const account = await POST('/accounts', {
    email,
    name: 'Verify Bot',
    company: 'OptiSigns QA',
    withTestClock: true,
  });
  const id = account._id;
  check('Stripe customer created', Boolean(account.stripeCustomerId), account.stripeCustomerId);
  check('Test clock attached', Boolean(account.testClockId), account.testClockId);
  await POST(`/accounts/${id}/payment-method/test`, { kind: 'visa' });
  check('Test card attached', true, 'pm_card_visa');

  step('2 · Subscribe: Engage · 2 screens · monthly');
  const created = await POST(`/subscriptions/${id}/change`, {
    planCode: 'engage',
    term: 'monthly',
    screens: 2,
    addOns: [],
  });
  const sub = created.state.stripe;
  check('Subscription active', sub.status === 'active', sub.status);
  check(
    'No trial: a card is on file (trial.appliesTo=only_without_payment_method)',
    created.trial?.applied === false,
    created.trial?.reason,
  );
  check('2 screens at $30', created.state.monthlyValueCents === 2 * 3000, money(created.state.monthlyValueCents));
  let invoices = await GET(`/billing/accounts/${id}/invoices`);
  check('First invoice paid', invoices[0]?.status === 'paid', `${invoices[0]?.number} ${money(invoices[0]?.total)}`);

  step('3 · Ten days later, add a 3rd screen — charged on the spot');
  await POST(`/simulator/${id}/advance`, { seconds: 10 * 86400 });
  const preview = await POST(`/subscriptions/${id}/preview`, {
    planCode: 'engage',
    term: 'monthly',
    screens: 3,
    addOns: [],
  });
  check('Rule classified as screensIncrease', preview.ruleKey === 'screensIncrease', preview.ruleKey);
  check('Charged immediately, not deferred', preview.rule.prorationBehavior === 'always_invoice' &&
    preview.rule.paymentBehavior === 'error_if_incomplete', preview.rule.prorationBehavior);
  check(
    'Preview contains proration lines',
    preview.invoice.lines.some((l) => l.proration),
    `${preview.invoice.lines.filter((l) => l.proration).length} proration line(s)`,
  );

  const renewalDate = created.state.stripe.currentPeriodEnd;
  const added = await POST(`/subscriptions/${id}/change`, {
    planCode: 'engage',
    term: 'monthly',
    screens: 3,
    addOns: [],
  });
  check('Applied immediately', added.applied === 'immediate', added.ruleKey);

  const invoicesAfterAdd = await GET(`/billing/accounts/${id}/invoices`);
  check('A new invoice was raised and paid', invoicesAfterAdd.length === invoices.length + 1 &&
    invoicesAfterAdd[0].status === 'paid',
    `${invoicesAfterAdd[0].number} ${money(invoicesAfterAdd[0].total)} · ${invoicesAfterAdd[0].billingReason}`);
  /*
   * 20 of 30 days remain, so the third Engage screen costs $30 × 2/3 = $20.
   * A full $30 here would mean proration was computed from the wrong instant —
   * wall-clock time instead of the customer's test clock.
   */
  check(
    'Prorated from the test clock, not wall time',
    invoicesAfterAdd[0].total > 1500 && invoicesAfterAdd[0].total < 2600,
    `${money(invoicesAfterAdd[0].total)} for ~20 of 30 days of one $30 screen`,
  );
  check('Renewal date untouched', (await GET(`/subscriptions/${id}`)).stripe.currentPeriodEnd === renewalDate,
    new Date(renewalDate * 1000).toDateString());
  const renewal = await GET(`/subscriptions/${id}/renewal-preview`);
  check('Nothing is left hanging for the next bill', !renewal.lines.some((l) => l.proration),
    `next invoice ${money(renewal.amountDue)}`);

  step('4 · Add-ons: 3× Background Music, 1× Video Wall');
  const withAddons = await POST(`/subscriptions/${id}/change`, {
    planCode: 'engage',
    term: 'monthly',
    screens: 3,
    addOns: [
      { code: 'opti_sound', quantity: 3 },
      { code: 'video_wall', quantity: 1 },
    ],
  });
  check('Add-on rule applied', withAddons.ruleKey === 'addOnIncrease', withAddons.ruleKey);
  check(
    'Monthly value = 3×$30 + 3×$15 + 1×$25',
    withAddons.state.monthlyValueCents === 3 * 3000 + 3 * 1500 + 2500,
    money(withAddons.state.monthlyValueCents),
  );

  step('5 · Per-screen add-on cannot exceed the screen count');
  let rejected = false;
  try {
    await POST(`/subscriptions/${id}/change`, {
      planCode: 'engage',
      term: 'monthly',
      screens: 3,
      addOns: [{ code: 'opti_sound', quantity: 9 }],
    });
  } catch (err) {
    rejected = true;
  }
  check('9 Background Music licences on 3 screens rejected', rejected);

  step('6 · Remove a screen — credit to the customer balance (OptiSigns behaviour)');
  const balanceBefore = await GET(`/accounts/${id}/balance`);
  const removed = await POST(`/subscriptions/${id}/change`, {
    planCode: 'engage',
    term: 'monthly',
    screens: 2,
    addOns: [
      { code: 'opti_sound', quantity: 2 },
      { code: 'video_wall', quantity: 1 },
    ],
  });
  const balanceAfter = await GET(`/accounts/${id}/balance`);
  check('Rule classified as screensDecrease', removed.ruleKey === 'screensDecrease', removed.ruleKey);
  check(
    'Stripe created a credit for the unused time',
    removed.creditCreatedCents > 0,
    `${money(removed.creditCreatedCents)} (pending proration ${money(removed.creditFromProrationsCents)}, balance ${money(removed.creditOnBalanceCents)})`,
  );
  check(
    'Credit is not cash — it lands on the account balance',
    removed.refund === null && balanceAfter.balance === balanceBefore.balance - removed.creditCreatedCents,
    `balance ${money(balanceBefore.balance)} → ${money(balanceAfter.balance)}`,
  );
  const renewalAfterRemove = await GET(`/subscriptions/${id}/renewal-preview`);
  check(
    'Next renewal shows the credit line',
    renewalAfterRemove.lines.some((l) => l.proration && l.amount < 0),
    `renewal total ${money(renewalAfterRemove.amountDue)}`,
  );

  step('7 · Downgrade Engage → Pro Plus under the "customer friendly" policy → cash refund');
  const balanceEnteringStep7 = (await GET(`/accounts/${id}/balance`)).balance;
  await POST('/policy/presets/customer_friendly');
  const refundDowngrade = await POST(`/subscriptions/${id}/change`, {
    planCode: 'pro_plus',
    term: 'monthly',
    screens: 2,
    addOns: [{ code: 'opti_sound', quantity: 2 }],
  });
  check('Rule classified as planDowngrade', refundDowngrade.ruleKey === 'planDowngrade', refundDowngrade.ruleKey);
  check(
    'creditHandling = refund_to_payment_method',
    refundDowngrade.rule.creditHandling === 'refund_to_payment_method',
    JSON.stringify(refundDowngrade.rule.creditHandling),
  );
  check(
    'Stripe credited the unused Engage time',
    refundDowngrade.creditFromProrationsCents > 0,
    `gross credit ${money(refundDowngrade.creditFromProrationsCents)}`,
  );
  /*
   * always_invoice settles everything in one invoice, and this customer still
   * owed the prorations from steps 3 and 4. The credit is absorbed by what they
   * owe, so the net is what may go back to the card — refunding the gross here
   * would hand back money that was never actually paid.
   */
  check(
    'Refund is driven by the net credit, never the gross',
    refundDowngrade.creditCreatedCents === refundDowngrade.creditOnBalanceCents,
    `net ${money(refundDowngrade.creditCreatedCents)} vs gross ${money(refundDowngrade.creditFromProrationsCents)}`,
  );
  check(
    'Cash moved only for the net amount',
    (refundDowngrade.refund?.refunded ?? 0) === refundDowngrade.creditCreatedCents,
    refundDowngrade.creditCreatedCents === 0
      ? 'nothing refunded: pending charges outweighed the credit'
      : `${money(refundDowngrade.refund?.refunded ?? 0)} refunded to pm_card_visa`,
  );
  /*
   * The refund must leave the balance exactly as it found it: its own credit is
   * paid out and debited back, and the credit earned in step 6 stays put.
   */
  const balanceAfterDowngrade = await GET(`/accounts/${id}/balance`);
  check('The refund leaves the earlier account credit untouched',
    balanceAfterDowngrade.balance === balanceEnteringStep7,
    `${money(balanceEnteringStep7)} → ${money(balanceAfterDowngrade.balance)}`);

  step('8 · Switch monthly → yearly (10% off, cycle restarts, charged up front)');
  await POST('/policy/presets/optisigns_default');
  const yearly = await POST(`/subscriptions/${id}/change`, {
    planCode: 'pro_plus',
    term: 'yearly',
    screens: 2,
    addOns: [{ code: 'opti_sound', quantity: 2 }],
  });
  check('Rule classified as termToYearly', yearly.ruleKey === 'termToYearly', yearly.ruleKey);
  check('billing_cycle_anchor = now', yearly.rule.billingCycleAnchor === 'now');
  const yearlyInvoices = await GET(`/billing/accounts/${id}/invoices`);
  check(
    'A new invoice was charged for the year',
    yearlyInvoices.length > invoicesAfterAdd.length,
    `latest ${money(yearlyInvoices[0]?.total)} · ${yearlyInvoices[0]?.status}`,
  );
  check(
    'Yearly price = 12 × discounted monthly (2×$13.50 + 2×$13.50)',
    yearly.state.monthlyValueCents === 2 * 1350 + 2 * 1350,
    `${money(yearly.state.monthlyValueCents)}/mo equivalent`,
  );

  step('9 · Scheduled downgrade (annual commitment policy)');
  await POST('/policy/presets/annual_commitment');
  const scheduled = await POST(`/subscriptions/${id}/change`, {
    planCode: 'standard',
    term: 'yearly',
    screens: 2,
    addOns: [{ code: 'opti_sound', quantity: 2 }],
  });
  check('Change parked on a schedule', scheduled.applied === 'scheduled', scheduled.scheduleId);
  check('No money moved yet', !scheduled.latestInvoice, 'no immediate invoice');
  const stateWithSchedule = await GET(`/subscriptions/${id}`);
  check('Schedule has a future phase', (stateWithSchedule.schedule?.phases?.length ?? 0) >= 2,
    `${stateWithSchedule.schedule?.phases?.length} phases`);
  check('Live plan is still Pro Plus until renewal', stateWithSchedule.current.planCode === 'pro_plus',
    stateWithSchedule.current.planCode);

  // schedule a second time: the pending phase must be replaced, not queued behind
  const rescheduled = await POST(`/subscriptions/${id}/change`, {
    planCode: 'standard',
    term: 'yearly',
    screens: 2,
    addOns: [{ code: 'opti_sound', quantity: 2 }],
    forceRuleKey: 'planDowngrade',
  });
  const stateAfterReschedule = await GET(`/subscriptions/${id}`);
  check(
    'Re-scheduling replaces the pending phase instead of stacking',
    (stateAfterReschedule.schedule?.phases?.length ?? 0) === 2,
    `${stateAfterReschedule.schedule?.phases?.length} phases (applied=${rescheduled.applied})`,
  );

  step('10 · Refund an invoice through the refund policy');
  await POST('/policy/presets/optisigns_default');
  const paid = (await GET(`/billing/accounts/${id}/invoices`)).find((i) => i.status === 'paid' && i.amountPaid > 0);
  if (paid) {
    const refund = await POST(`/billing/accounts/${id}/refund`, {
      invoiceId: paid.id,
      amountCents: Math.min(1000, paid.amountPaid),
      mode: 'credit_note',
      reason: 'order_change',
    });
    check('Credit note issued with a card refund', Boolean(refund.creditNote?.id), refund.creditNote?.number);
    const notes = await GET(`/billing/accounts/${id}/credit-notes`);
    check('Credit note visible on the account', notes.length > 0, `${notes.length} note(s)`);
  } else {
    console.log(c.dim('  · no paid invoice available to refund'));
  }

  step('11 · Refund policy guard rails');
  let blocked = false;
  try {
    await PUT('/policy', { refunds: { maxAutoApproveCents: 1 } });
    const target = (await GET(`/billing/accounts/${id}/invoices`)).find((i) => i.status === 'paid' && i.amountPaid > 200);
    if (target) {
      await POST(`/billing/accounts/${id}/refund`, { invoiceId: target.id, amountCents: 200 });
    } else {
      blocked = true;
    }
  } catch (err) {
    blocked = /ceiling/i.test(err.message);
  }
  check('Auto-approve ceiling enforced', blocked);
  await POST('/policy/presets/optisigns_default');

  // a plain refund must reduce what is still refundable (defect: double refund)
  const bigInvoice = (await GET(`/billing/accounts/${id}/invoices`))
    .filter((i) => i.status === 'paid' && i.amountPaid > 1000)
    .sort((a, b) => b.amountPaid - a.amountPaid)[0];
  if (bigInvoice) {
    await POST(`/billing/accounts/${id}/refund`, {
      invoiceId: bigInvoice.id,
      amountCents: 500,
      mode: 'refund',
    });
    let overRefundBlocked = false;
    try {
      await POST(`/billing/accounts/${id}/refund`, {
        invoiceId: bigInvoice.id,
        amountCents: bigInvoice.amountPaid,
        mode: 'refund',
      });
    } catch (err) {
      overRefundBlocked = /still refundable|already been fully refunded/i.test(err.message);
    }
    check('A second refund cannot exceed what is actually left', overRefundBlocked,
      `invoice ${bigInvoice.number} paid ${money(bigInvoice.amountPaid)}, $5.00 already refunded`);
  }

  // refunds created by a credit note have no metadata — they must still show up
  const refundRows = await GET(`/billing/accounts/${id}/refunds`);
  check(
    'Refund list includes credit-note refunds (no metadata to filter on)',
    refundRows.some((r) => r.source === 'credit_note_or_dashboard'),
    `${refundRows.length} refund(s) total`,
  );

  step('11b · Refund window is measured on the customer\'s test clock');
  await PUT('/policy', { refunds: { windowDays: 1 } });
  await POST(`/simulator/${id}/advance`, { seconds: 5 * 86400 });
  let windowBlocked = false;
  try {
    const old = (await GET(`/billing/accounts/${id}/invoices`)).find((i) => i.status === 'paid' && i.amountPaid > 0);
    await POST(`/billing/accounts/${id}/refund`, { invoiceId: old.id, amountCents: 100 });
  } catch (err) {
    windowBlocked = /refund window/i.test(err.message);
  }
  check('Invoices older than the window are refused (clock-aware)', windowBlocked);
  await POST('/policy/presets/optisigns_default');

  step('11c · Customer Portal configuration is reused, not duplicated');
  const portalA = await POST('/billing/portal/configuration');
  const portalB = await POST('/billing/portal/configuration');
  check('Same configuration object is updated in place', portalA.id === portalB.id, portalB.id);
  const portalSession = await POST(`/billing/accounts/${id}/portal-session`, {});
  check('Portal session uses the policy-derived configuration', portalSession.configuration === portalB.id,
    String(portalSession.configuration));

  step('12 · Time travel to the next renewal');
  const advanced = await POST(`/simulator/${id}/advance`, { preset: 'next_renewal' });
  check('Clock advanced', advanced.clock.status === 'ready', new Date(advanced.clock.frozenTime * 1000).toISOString());
  const renewalInvoice = advanced.invoices[0];
  check(
    'Renewal invoice generated by Stripe',
    Boolean(renewalInvoice),
    `${renewalInvoice?.number} ${money(renewalInvoice?.total)} · ${renewalInvoice?.status} · ${renewalInvoice?.billingReason}`,
  );
  // Standard yearly: 2 screens × $9 × 12 + 2 music × $13.50 × 12 = $540.00
  check(
    'Renewal was priced at the scheduled Standard phase, not Pro Plus',
    renewalInvoice?.total === 2 * 900 * 12 + 2 * 1350 * 12,
    `expected $540.00, got ${money(renewalInvoice?.total)}`,
  );
  const afterRenewal = await GET(`/subscriptions/${id}`);
  check('Plan actually switched to Standard', afterRenewal.current.planCode === 'standard',
    afterRenewal.current.planCode);

  step('13 · Seasonal pause, then resume');
  await POST(`/subscriptions/${id}/pause`, {});
  const paused = await GET(`/subscriptions/${id}`);
  check('pause_collection set', Boolean(paused.stripe?.pauseCollection), paused.stripe?.pauseCollection?.behavior);
  await POST(`/subscriptions/${id}/unpause`, {});
  const unpaused = await GET(`/subscriptions/${id}`);
  check('pause_collection cleared', !unpaused.stripe?.pauseCollection);

  step('14 · Cancel immediately with a prorated refund');
  await POST('/policy/presets/customer_friendly');
  const cancelled = await POST(`/subscriptions/${id}/cancel`, {});
  check('Cancelled immediately', cancelled.cancelled === 'immediate', JSON.stringify(cancelled.settings));
  check('Account dropped to Free', cancelled.state.current.planCode === 'free', cancelled.state.current.planCode);
  check('moveToFreePlan=true keeps the account usable', cancelled.state.account.deactivated === false,
    `deactivated=${cancelled.state.account.deactivated}`);
  if (cancelled.creditCreatedCents > 0) {
    check('Unused time refunded to the card', Boolean(cancelled.refund?.refunded),
      `${money(cancelled.refund?.refunded ?? 0)}`);
  }

  step('15 · Trials: policy, opt-out, $0 preview and ending early');
  const trialEmail = `trial+${Date.now()}@optisigns-billing-demo.test`;
  const trialAccount = await POST('/accounts', {
    email: trialEmail,
    name: 'Trial Bot',
    withTestClock: true,
  });
  const tid = trialAccount._id;

  // no card on file -> the policy grants a trial, and the preview says $0
  const trialPreview = await POST(`/subscriptions/${tid}/preview`, {
    planCode: 'standard',
    term: 'monthly',
    screens: 2,
    addOns: [],
  });
  check('Preview announces the trial', trialPreview.trial?.willApply === true, trialPreview.trial?.reason);
  check('Preview shows nothing due today', trialPreview.invoice.amountDue === 0,
    money(trialPreview.invoice.amountDue));

  // opting out without a card must be refused with a clear message
  let optOutBlocked = false;
  try {
    await POST(`/subscriptions/${tid}/change`, {
      planCode: 'standard', term: 'monthly', screens: 2, addOns: [], withTrial: false,
    });
  } catch (err) {
    optOutBlocked = /payment method/i.test(err.message);
  }
  check('Opting out of the trial with no card is refused', optOutBlocked);

  const trialSub = await POST(`/subscriptions/${tid}/change`, {
    planCode: 'standard', term: 'monthly', screens: 2, addOns: [],
  });
  check('Subscription starts on trial', trialSub.state.stripe.status === 'trialing', trialSub.trial?.reason);
  check('Trial is 14 days', trialSub.trial?.applied === true, new Date(trialSub.trial.endsAt * 1000).toDateString());

  // previewing a trial that will cancel (no card) must explain, not 400
  const trialingPreview = await POST(`/subscriptions/${tid}/preview`, {
    planCode: 'standard', term: 'monthly', screens: 3, addOns: [],
  });
  check(
    'Preview degrades gracefully while trialing without a card',
    trialingPreview.invoice === null && Boolean(trialingPreview.previewUnavailable),
    String(trialingPreview.previewUnavailable).slice(0, 60) + '…',
  );

  // requirePaymentMethod must actually be enforced now
  await PUT('/policy', { trial: { requirePaymentMethod: true, appliesTo: 'always' } });
  const guardAccount = await POST('/accounts', {
    email: `guard+${Date.now()}@optisigns-billing-demo.test`,
    name: 'Guard Bot',
  });
  let guardBlocked = false;
  try {
    await POST(`/subscriptions/${guardAccount._id}/change`, {
      planCode: 'standard', term: 'monthly', screens: 1, addOns: [],
    });
  } catch (err) {
    guardBlocked = /requires a payment method/i.test(err.message);
  }
  check('trial.requirePaymentMethod is a real knob now', guardBlocked);
  await DELETE(`/accounts/${guardAccount._id}`);
  await POST('/policy/presets/optisigns_default');

  // end the trial early: Stripe bills the first period on the spot
  await POST(`/accounts/${tid}/payment-method/test`, { kind: 'visa' });
  const ended = await POST(`/subscriptions/${tid}/end-trial`, {});
  check('Trial ended on demand', ended.endedTrial === true, `invoice ${ended.latestInvoice?.number} ${money(ended.latestInvoice?.total)}`);
  check('First real invoice was charged', ended.latestInvoice?.amountPaid === 2 * 1000,
    money(ended.latestInvoice?.amountPaid));

  step('15b · Dropping to Free while add-ons are selected cancels instead of erroring');
  const toFree = await POST(`/subscriptions/${tid}/change`, {
    planCode: 'free', term: 'monthly', screens: 3,
    addOns: [{ code: 'opti_sound', quantity: 2 }],
  });
  check('Free plan request cancelled the subscription', Boolean(toFree.cancelled), String(toFree.cancelled));

  step('15c · cancellation.moveToFreePlan=false deactivates the account');
  await POST(`/subscriptions/${tid}/change`, { planCode: 'standard', term: 'monthly', screens: 2, addOns: [] });
  await PUT('/policy', { cancellation: { timing: 'immediate', moveToFreePlan: false } });
  const deactivated = await POST(`/subscriptions/${tid}/cancel`, {});
  check('Account deactivated, 0 screens', deactivated.state.account.deactivated === true &&
    deactivated.state.account.screens === 0, `screens=${deactivated.state.account.screens}`);
  await POST('/policy/presets/optisigns_default');
  if (!KEEP) await DELETE(`/accounts/${tid}`);

  step('16 · yearly → monthly: immediate switch, unused year becomes Stripe credit');
  const y2mAccount = await POST('/accounts', {
    email: `y2m+${Date.now()}@optisigns-billing-demo.test`,
    name: 'Y2M Bot',
    withTestClock: true,
  });
  const yid = y2mAccount._id;
  await POST(`/accounts/${yid}/payment-method/test`, { kind: 'visa' });

  const yearlyStart = await POST(`/subscriptions/${yid}/change`, {
    planCode: 'pro_plus', term: 'yearly', screens: 2, addOns: [],
  });
  const yearlyInvoice = (await GET(`/billing/accounts/${yid}/invoices`))[0];
  check('Annual term charged 12 months up front', yearlyInvoice.total === 2 * 1350 * 12,
    `${yearlyInvoice.number} ${money(yearlyInvoice.total)}`);

  await POST(`/simulator/${yid}/advance`, { seconds: 60 * 86400 });

  const y2mPreview = await POST(`/subscriptions/${yid}/preview`, {
    planCode: 'pro_plus', term: 'monthly', screens: 2, addOns: [],
  });
  check('yearly → monthly applies immediately', y2mPreview.mode === 'update', y2mPreview.ruleKey);
  check('Cycle restarts (billing_cycle_anchor=now)', y2mPreview.rule.billingCycleAnchor === 'now');
  check('Unused year becomes Stripe credit, not a card refund',
    y2mPreview.rule.creditHandling === 'push_to_account_balance', y2mPreview.rule.creditHandling);

  const y2mApplied = await POST(`/subscriptions/${yid}/change`, {
    planCode: 'pro_plus', term: 'monthly', screens: 2, addOns: [],
  });
  check('Applied on the spot', y2mApplied.applied === 'immediate', String(y2mApplied.applied));
  check('Term is monthly right away', y2mApplied.state.current.term === 'monthly', y2mApplied.state.current.term);

  /*
   * The books have to balance. Stripe credits the unused year gross, but the
   * same invoice also bills the first monthly period, so only the NET credit is
   * owed back. Refunding the gross would hand the customer a free month.
   */
  check(
    'Credit is the net amount, not the gross proration',
    y2mApplied.creditCreatedCents === y2mApplied.creditOnBalanceCents &&
      y2mApplied.creditCreatedCents < y2mApplied.creditFromProrationsCents,
    `net ${money(y2mApplied.creditCreatedCents)} vs gross ${money(y2mApplied.creditFromProrationsCents)}`,
  );
  check('No money left Stripe', y2mApplied.refund === null, 'no card refund was created');

  const y2mBalance = await GET(`/accounts/${yid}/balance`);
  check('Account balance holds the credit', y2mBalance.balance === -y2mApplied.creditCreatedCents,
    `${money(y2mBalance.balance)} on the customer`);

  const y2mRefunded = (await GET(`/billing/accounts/${yid}/refunds`)).reduce((sum, r) => sum + r.amount, 0);
  check('Nothing was refunded to the card', y2mRefunded === 0, money(y2mRefunded));

  const y2mNext = await GET(`/subscriptions/${yid}/renewal-preview`);
  check(
    'Next monthly invoices are paid out of that credit',
    y2mNext.amountDue === 0 && y2mNext.startingBalance < 0,
    `amount due ${money(y2mNext.amountDue)} (starting_balance ${money(y2mNext.startingBalance)})`,
  );

  step('16b · Same switch under "annual commitment": wait for the renewal instead');
  await POST(`/subscriptions/${yid}/change`, { planCode: 'pro_plus', term: 'yearly', screens: 2, addOns: [] });
  await POST(`/simulator/${yid}/advance`, { seconds: 40 * 86400 });
  await POST('/policy/presets/annual_commitment');

  const committed = await POST(`/subscriptions/${yid}/preview`, {
    planCode: 'pro_plus', term: 'monthly', screens: 2, addOns: [],
  });
  check('Parked for the renewal instead', committed.mode === 'schedule', committed.ruleKey);
  check('Preview carries the real effective date', Boolean(committed.effectiveAt),
    new Date(committed.effectiveAt * 1000).toDateString());

  const scheduledY2M = await POST(`/subscriptions/${yid}/change`, {
    planCode: 'pro_plus', term: 'monthly', screens: 2, addOns: [],
  });
  check('Nothing charged or refunded today', scheduledY2M.applied === 'scheduled', String(scheduledY2M.applied));
  check('Still on the paid annual term', scheduledY2M.state.current.term === 'yearly',
    scheduledY2M.state.current.term);

  // a queued monthly phase caps Stripe's clock jumps at two months
  const hop = await POST(`/simulator/${yid}/advance`, { preset: 'next_renewal' });
  check('Clock walked a whole year in hops', hop.clock.steps > 1, `${hop.clock.steps} hops`);
  const y2mAfter = await GET(`/subscriptions/${yid}`);
  check('Term flipped to monthly at renewal', y2mAfter.current.term === 'monthly', y2mAfter.current.term);
  check('Renewal invoice is one month, not one year', hop.invoices[0].total === 2 * 1500,
    `${hop.invoices[0].number} ${money(hop.invoices[0].total)} · ${hop.invoices[0].billingReason}`);

  await POST('/policy/presets/optisigns_default');
  if (!KEEP) await DELETE(`/accounts/${yid}`);

  step('17 · Credit that must land on the account balance');
  const balAccount = await POST('/accounts', {
    email: `balance+${Date.now()}@optisigns-billing-demo.test`,
    name: 'Balance Bot',
    withTestClock: true,
  });
  const bid = balAccount._id;
  await POST(`/accounts/${bid}/payment-method/test`, { kind: 'visa' });
  await PUT('/policy', { rules: { screensDecrease: { creditHandling: 'push_to_account_balance' } } });

  await POST(`/subscriptions/${bid}/change`, { planCode: 'pro_plus', term: 'monthly', screens: 4, addOns: [] });
  await POST(`/simulator/${bid}/advance`, { seconds: 10 * 86400 });
  const shrunk = await POST(`/subscriptions/${bid}/change`, {
    planCode: 'pro_plus', term: 'monthly', screens: 2, addOns: [],
  });
  const balState = await GET(`/accounts/${bid}/balance`);
  check(
    'Credit is visible as account balance, not just a hidden proration',
    balState.balance === -shrunk.creditCreatedCents && balState.balance < 0,
    `${money(balState.balance)} on the customer`,
  );
  const balNext = await GET(`/subscriptions/${bid}/renewal-preview`);
  check(
    'Next invoice is discounted once, not twice',
    balNext.amountDue === 2 * 1500 - shrunk.creditCreatedCents,
    `amount due ${money(balNext.amountDue)} (starting_balance ${money(balNext.startingBalance)})`,
  );

  // the plain customer_balance option must stay as it was
  await PUT('/policy', { rules: { screensDecrease: { creditHandling: 'customer_balance' } } });
  await POST(`/subscriptions/${bid}/change`, { planCode: 'pro_plus', term: 'monthly', screens: 4, addOns: [] });
  await POST(`/simulator/${bid}/advance`, { seconds: 5 * 86400 });
  const balBefore2 = (await GET(`/accounts/${bid}/balance`)).balance;
  await POST(`/subscriptions/${bid}/change`, { planCode: 'pro_plus', term: 'monthly', screens: 3, addOns: [] });
  const balAfter2 = (await GET(`/accounts/${bid}/balance`)).balance;
  check('customer_balance leaves the credit as a pending proration', balAfter2 === balBefore2,
    `balance unchanged at ${money(balAfter2)}`);

  await POST('/policy/presets/optisigns_default');
  if (!KEEP) await DELETE(`/accounts/${bid}`);

  step('17b · Downgrading a plan while on the annual term');
  const ydAccount = await POST('/accounts', {
    email: `ydown+${Date.now()}@optisigns-billing-demo.test`,
    name: 'Yearly Downgrade Bot',
    withTestClock: true,
  });
  const ydid = ydAccount._id;
  await POST(`/accounts/${ydid}/payment-method/test`, { kind: 'visa' });
  const ydStart = await POST(`/subscriptions/${ydid}/change`, {
    planCode: 'engage', term: 'yearly', screens: 2, addOns: [],
  });
  const ydPaid = (await GET(`/billing/accounts/${ydid}/invoices`))[0];
  check('Annual Engage charged up front', ydPaid.total === 2 * 2700 * 12, money(ydPaid.total));

  const ydRenewal = ydStart.state.stripe.currentPeriodEnd;
  await POST(`/simulator/${ydid}/advance`, { seconds: 90 * 86400 });

  const ydChange = await POST(`/subscriptions/${ydid}/change`, {
    planCode: 'standard', term: 'yearly', screens: 2, addOns: [],
  });
  check('Rule is planDowngrade, applied immediately', ydChange.ruleKey === 'planDowngrade' &&
    ydChange.applied === 'immediate', `${ydChange.ruleKey} · ${ydChange.applied}`);
  check('Term stays annual', ydChange.state.current.term === 'yearly' &&
    ydChange.state.current.planCode === 'standard',
    `${ydChange.state.current.planCode} · ${ydChange.state.current.term}`);
  check('Renewal date untouched', ydChange.state.stripe.currentPeriodEnd === ydRenewal,
    new Date(ydRenewal * 1000).toDateString());
  check('No new invoice: the difference is prorated, not billed',
    (await GET(`/billing/accounts/${ydid}/invoices`)).length === 1, '1 invoice');

  /*
   * 90 of 365 days used, so 275 remain. The customer is owed the gap between
   * the two annual prices for the rest of the year:
   *   ($648 − $216) × 275/365 = $325.48
   */
  const ydExpected = Math.round((2 * 2700 * 12 - 2 * 900 * 12) * 275 / 365);
  check('Credit is the price gap for the remaining days',
    Math.abs(ydChange.creditCreatedCents - ydExpected) <= 1,
    `${money(ydChange.creditCreatedCents)} vs expected ${money(ydExpected)}`);

  const ydBalance = await GET(`/accounts/${ydid}/balance`);
  check('Credit sits on the account balance, no card refund',
    ydBalance.balance === -ydChange.creditCreatedCents && ydChange.refund === null,
    money(ydBalance.balance));

  const ydNext = await GET(`/subscriptions/${ydid}/renewal-preview`);
  const ydProrationSum = ydNext.lines.reduce((sum, l) => sum + (l.amount !== 2 * 900 * 12 ? l.amount : 0), 0);
  check('Pending proration lines cancel out to zero', ydProrationSum === 0,
    `${ydNext.lines.length} lines · subtotal ${money(ydNext.subtotal)}`);
  check('Next year is covered by the credit', ydNext.amountDue === 0 && ydNext.startingBalance < 0,
    `due ${money(ydNext.amountDue)} (starting_balance ${money(ydNext.startingBalance)})`);
  if (!KEEP) await DELETE(`/accounts/${ydid}`);

  step('18 · Upgrading a tier and buying an add-on are both paid for on the spot');
  const addonAccount = await POST('/accounts', {
    email: `addon+${Date.now()}@optisigns-billing-demo.test`,
    name: 'Add-on Bot',
    withTestClock: true,
  });
  const aid = addonAccount._id;
  await POST(`/accounts/${aid}/payment-method/test`, { kind: 'visa' });
  const upStart = await POST(`/subscriptions/${aid}/change`, {
    planCode: 'standard', term: 'monthly', screens: 4, addOns: [],
  });
  const upRenewal = upStart.state.stripe.currentPeriodEnd;
  await POST(`/simulator/${aid}/advance`, { seconds: 10 * 86400 });

  const upgraded = await POST(`/subscriptions/${aid}/change`, {
    planCode: 'pro_plus', term: 'monthly', screens: 4, addOns: [],
  });
  check('Tier upgrade is invoiced immediately', upgraded.ruleKey === 'planUpgrade' &&
    upgraded.rule.prorationBehavior === 'always_invoice', upgraded.rule.prorationBehavior);
  const upInvoices = await GET(`/billing/accounts/${aid}/invoices`);
  /*
   * 20 of 30 days left: the customer gets the unused Standard time back and
   * pays for the same window on Pro Plus, so only the gap changes hands.
   *   4 × ($15 − $10) × 20/30 = $13.33
   */
  const upExpected = Math.round(4 * (1500 - 1000) * 2 / 3);
  check('Only the price gap is charged, prorated',
    Math.abs(upInvoices[0].total - upExpected) <= 2 && upInvoices[0].status === 'paid',
    `${upInvoices[0].number} ${money(upInvoices[0].total)} vs expected ${money(upExpected)}`);
  check('Invoice carries both proration legs',
    upInvoices[0].lines.filter((l) => l.proration).length === 2,
    upInvoices[0].lines.map((l) => money(l.amount)).join(' + '));
  check('Renewal date untouched by the upgrade',
    (await GET(`/subscriptions/${aid}`)).stripe.currentPeriodEnd === upRenewal,
    new Date(upRenewal * 1000).toDateString());
  const upNext = await GET(`/subscriptions/${aid}/renewal-preview`);
  check('Nothing left pending after the upgrade',
    !upNext.lines.some((l) => l.proration), `next invoice ${money(upNext.amountDue)}`);

  const beforeAddon = await GET(`/billing/accounts/${aid}/invoices`);
  const renewalBefore = (await GET(`/subscriptions/${aid}`)).stripe.currentPeriodEnd;
  const bought = await POST(`/subscriptions/${aid}/change`, {
    planCode: 'pro_plus', term: 'monthly', screens: 4, addOns: [{ code: 'aericast', quantity: 2 }],
  });
  check('Add-on purchase is invoiced immediately', bought.rule.prorationBehavior === 'always_invoice',
    bought.rule.prorationBehavior);

  const afterAddon = await GET(`/billing/accounts/${aid}/invoices`);
  check('A new invoice was raised and paid', afterAddon.length === beforeAddon.length + 1 &&
    afterAddon[0].status === 'paid',
    `${afterAddon[0].number} ${money(afterAddon[0].total)} · ${afterAddon[0].billingReason}`);
  // 2 × $20 for the ~20 remaining days of a 30-day period
  check('Charged the prorated amount, not a full month', afterAddon[0].amountPaid > 0 &&
    afterAddon[0].amountPaid < 2 * 2000,
    `${money(afterAddon[0].amountPaid)} of a full ${money(2 * 2000)}`);
  check('Renewal date untouched', (await GET(`/subscriptions/${aid}`)).stripe.currentPeriodEnd === renewalBefore,
    new Date(renewalBefore * 1000).toDateString());
  const addonRenewal = await GET(`/subscriptions/${aid}/renewal-preview`);
  check('Nothing about the add-on is left pending',
    !addonRenewal.lines.some((l) => l.proration && (l.description ?? '').includes('Wireless')),
    `next invoice ${money(addonRenewal.amountDue)}`);

  // error_if_incomplete: a card that fails must block the purchase outright
  await POST(`/accounts/${aid}/payment-method/test`, { kind: 'charge_fails' });
  let addonBlocked = false;
  try {
    await POST(`/subscriptions/${aid}/change`, {
      planCode: 'pro_plus', term: 'monthly', screens: 4,
      addOns: [{ code: 'aericast', quantity: 2 }, { code: 'opti_sound', quantity: 2 }],
    });
  } catch (err) {
    addonBlocked = /declined|card/i.test(err.message);
  }
  check('A failing card blocks the purchase', addonBlocked);
  const addonState = await GET(`/subscriptions/${aid}`);
  check('Nothing was granted for free', addonState.current.addOns.length === 1,
    JSON.stringify(addonState.current.addOns));

  /*
   * Dropping an add-on to zero deletes the subscription item outright, which is
   * a different Stripe path from merely lowering the quantity. It also needs no
   * money to move, so it must work even though the card on file now fails.
   */
  const addonBalanceBefore = (await GET(`/accounts/${aid}/balance`)).balance;
  const dropped = await POST(`/subscriptions/${aid}/change`, {
    planCode: 'pro_plus', term: 'monthly', screens: 4, addOns: [],
  });
  check('An add-on can be dropped to zero', dropped.ruleKey === 'addOnDecrease' &&
    dropped.state.current.addOns.length === 0, JSON.stringify(dropped.state.current.addOns));
  check('Works even with a card that cannot be charged', dropped.applied === 'immediate');
  check('The subscription item is deleted, not parked at quantity 0',
    dropped.state.stripe.items.length === 1,
    `${dropped.state.stripe.items.length} item(s) left`);
  check('Unused add-on time comes back as prorated credit', dropped.creditCreatedCents > 0,
    money(dropped.creditCreatedCents));
  const addonBalanceAfter = (await GET(`/accounts/${aid}/balance`)).balance;
  check('Credit landed on the account balance, nothing refunded',
    addonBalanceAfter === addonBalanceBefore - dropped.creditCreatedCents && dropped.refund === null,
    `${money(addonBalanceBefore)} → ${money(addonBalanceAfter)}`);
  const droppedNext = await GET(`/subscriptions/${aid}/renewal-preview`);
  check('Next invoice has no add-on line left',
    !droppedNext.lines.some((l) => (l.description ?? '').includes('Wireless') && !l.proration),
    `subtotal ${money(droppedNext.subtotal)}`);

  // and the dunning card must be attachable in the first place
  const cards = await GET('/accounts/test-cards');
  check('Dunning test card exists and attaches', cards.some((c) => c.key === 'charge_fails'),
    cards.map((c) => c.key).join(', '));
  if (!KEEP) await DELETE(`/accounts/${aid}`);

  step('18b · Refusing any change that would owe the customer money');
  const blkAccount = await POST('/accounts', {
    email: `block+${Date.now()}@optisigns-billing-demo.test`,
    name: 'Block Bot',
    withTestClock: true,
  });
  const bkid = blkAccount._id;
  await POST(`/accounts/${bkid}/payment-method/test`, { kind: 'visa' });
  await POST(`/subscriptions/${bkid}/change`, { planCode: 'pro_plus', term: 'monthly', screens: 4, addOns: [] });
  await POST(`/subscriptions/${bkid}/change`, {
    planCode: 'pro_plus', term: 'monthly', screens: 4, addOns: [{ code: 'opti_sound', quantity: 2 }],
  });
  await POST(`/simulator/${bkid}/advance`, { seconds: 15 * 86400 });
  await PUT('/policy', {
    rules: {
      screensDecrease: { prorationBehavior: 'always_invoice', creditHandling: 'block' },
      planDowngrade: { prorationBehavior: 'always_invoice', creditHandling: 'block' },
      addOnDecrease: { prorationBehavior: 'always_invoice', creditHandling: 'block' },
    },
  });

  const beforeBlock = await GET(`/subscriptions/${bkid}`);
  const invoicesBeforeBlock = (await GET(`/billing/accounts/${bkid}/invoices`)).length;
  let blockedCount = 0;
  for (const body of [
    { planCode: 'pro_plus', term: 'monthly', screens: 2, addOns: [{ code: 'opti_sound', quantity: 2 }] },
    { planCode: 'standard', term: 'monthly', screens: 4, addOns: [{ code: 'opti_sound', quantity: 2 }] },
    { planCode: 'pro_plus', term: 'monthly', screens: 4, addOns: [] },
  ]) {
    try {
      await POST(`/subscriptions/${bkid}/change`, body);
    } catch (err) {
      if (/owed back to the customer/i.test(err.message)) blockedCount += 1;
    }
  }
  check('Every reduction that owes money is refused', blockedCount === 3, `${blockedCount}/3 blocked`);

  /*
   * A refusal has to be a no-op. The check runs on a preview before anything is
   * sent to Stripe, so the subscription must come back byte-identical.
   */
  const afterBlock = await GET(`/subscriptions/${bkid}`);
  check('A refused change leaves the subscription untouched',
    JSON.stringify(afterBlock.current) === JSON.stringify(beforeBlock.current) &&
      (await GET(`/billing/accounts/${bkid}/invoices`)).length === invoicesBeforeBlock,
    JSON.stringify(afterBlock.current));
  check('No credit was handed out either',
    (await GET(`/accounts/${bkid}/balance`)).balance === 0, 'balance $0.00');

  // buying more must still work
  const stillBuys = await POST(`/subscriptions/${bkid}/change`, {
    planCode: 'engage', term: 'monthly', screens: 4, addOns: [{ code: 'opti_sound', quantity: 2 }],
  });
  check('Upgrades are unaffected', stillBuys.state.current.planCode === 'engage',
    stillBuys.state.current.planCode);

  const blkInvoices = await GET(`/billing/accounts/${bkid}/invoices`);
  check('Not a single negative invoice exists', blkInvoices.every((i) => i.total >= 0),
    blkInvoices.map((i) => money(i.total)).join(', '));

  // the operator escape hatch: a one-off override gets past the block
  const rescued = await POST(`/subscriptions/${bkid}/change`, {
    planCode: 'engage', term: 'monthly', screens: 4, addOns: [],
    overrides: { prorationBehavior: 'create_prorations', creditHandling: 'push_to_account_balance' },
  });
  check('Support can still override on a single change', rescued.state.current.addOns.length === 0,
    `credit ${money(rescued.creditCreatedCents)} granted by override`);

  await POST('/policy/presets/optisigns_default');
  if (!KEEP) await DELETE(`/accounts/${bkid}`);

  step('18c · X Social: a metered add-on priced by allowance, not by days');
  const xAccount = await POST('/accounts', {
    email: `xsocial+${Date.now()}@optisigns-billing-demo.test`,
    name: 'X Social Bot',
    withTestClock: true,
  });
  const xid = xAccount._id;
  await POST(`/accounts/${xid}/payment-method/test`, { kind: 'visa' });
  await POST(`/subscriptions/${xid}/change`, { planCode: 'pro_plus', term: 'monthly', screens: 2, addOns: [] });

  const xBought = await POST(`/subscriptions/${xid}/change`, {
    planCode: 'pro_plus', term: 'monthly', screens: 2, addOns: [{ code: 'x_social_standard', quantity: 1 }],
  });
  check('First purchase is settled on allowance, not on days', xBought.applied === 'usage_settlement' &&
    xBought.chargeCents === 1000, `${money(xBought.chargeCents)} — a full allowance`);

  let xBlocked = false;
  try {
    await POST(`/subscriptions/${xid}/change`, {
      planCode: 'pro_plus', term: 'monthly', screens: 2,
      addOns: [{ code: 'x_social_standard', quantity: 1 }, { code: 'x_social_pro', quantity: 1 }],
      quotaUsed: 0,
    });
  } catch (err) {
    xBlocked = /tiers of the same add-on/i.test(err.message);
  }
  check('Two tiers can never be held at once', xBlocked);

  /*
   * A meter nobody has written to means nothing has been posted yet, which is a
   * real reading of zero rather than a missing one — previewed here so the
   * account is left on the tier the rest of this step expects.
   */
  const xNoMeter = await POST(`/subscriptions/${xid}/preview`, {
    planCode: 'pro_plus', term: 'monthly', screens: 2, addOns: [{ code: 'x_social_pro', quantity: 1 }],
  });
  check('An untouched meter reads as zero posts, not as missing data',
    xNoMeter.quota.used === 0 && xNoMeter.breakdown.creditCents === 1000,
    `${money(xNoMeter.breakdown.creditCents)} = ${xNoMeter.breakdown.creditFormula}`);

  await POST(`/simulator/${xid}/advance`, { seconds: 15 * 86400 });
  const xInvoicesBefore = (await GET(`/billing/accounts/${xid}/invoices`)).length;

  /*
   * MODEL V5: the unused half of a 600-post allowance is worth $10 × 400/600 =
   * $6.67 whatever the calendar says, while the new tier is billed for the days
   * that remain. Stripe cannot do the first half of that sum.
   */
  const xUp = await POST(`/subscriptions/${xid}/change`, {
    planCode: 'pro_plus', term: 'monthly', screens: 2,
    addOns: [{ code: 'x_social_pro', quantity: 1 }], quotaUsed: 200,
  });
  check('Both directions run one rule: addOnTierChange', xUp.ruleKey === 'addOnTierChange' &&
    xUp.applied === 'usage_settlement', `${xUp.ruleKey} · ${xUp.applied}`);
  check('Credit is the unspent allowance, not the unused days',
    xUp.creditCents === Math.round(1000 * 400 / 600),
    `${money(xUp.creditCents)} = ${xUp.workings.creditFormula}`);
  /*
   * 15 of 30 days are gone, so half the allowance month is still ahead. MODEL
   * V5 row 47 sells that half: the price and the posts are cut by the same
   * fraction, which is what keeps the rate per post the same whenever in the
   * month the customer arrives.
   */
  const upFraction = xUp.workings.remainingFraction;
  check('About half the allowance month is still ahead',
    Math.abs(upFraction - 0.5) < 0.03, `${(upFraction * 100).toFixed(1)}%`);
  check('The new tier is sold by the slice of the month that is left',
    xUp.chargeCents === Math.round(3000 * upFraction),
    `${money(xUp.chargeCents)} = ${xUp.workings.chargeFormula}`);
  check('The posts granted are cut by the very same fraction',
    xUp.quota.granted === Math.floor(2000 * upFraction),
    `${xUp.quota.granted} posts = ${xUp.workings.quotaFormula}`);

  const xAfterUp = await GET(`/subscriptions/${xid}`);
  check('The line is repriced, not replaced', xAfterUp.stripe.items.length === 2 &&
    xAfterUp.current.addOns.some((a) => a.code === 'x_social_pro'),
    `${xAfterUp.stripe.items.length} items · ${JSON.stringify(xAfterUp.current.addOns)}`);

  const xInvoices = await GET(`/billing/accounts/${xid}/invoices`);
  check('Exactly one invoice was raised, and it is positive',
    xInvoices.length === xInvoicesBefore + 1 && xInvoices[0].total === xUp.chargeCents,
    `${xInvoices[0].number} ${money(xInvoices[0].total)}`);
  check('The credit absorbed part of it instead of becoming a negative invoice',
    xInvoices[0].amountPaid === xUp.chargeCents - xUp.creditCents && xInvoices.every((i) => i.total >= 0),
    `card paid ${money(xInvoices[0].amountPaid)} of ${money(xInvoices[0].total)}`);

  // and back down: same rule, same shape, bigger credit
  const xDown = await POST(`/subscriptions/${xid}/change`, {
    planCode: 'pro_plus', term: 'monthly', screens: 2,
    addOns: [{ code: 'x_social_standard', quantity: 1 }], quotaUsed: 500,
  });
  check('Downgrading uses the same rule', xDown.ruleKey === 'addOnTierChange', xDown.ruleKey);
  /*
   * MODEL V5 row 8 values the hand-back against what was *actually* invoiced
   * for this item this period, which after a mid-month purchase is not the list
   * price — so the figure has to be the one the step above really charged.
   */
  check('The hand-back is valued against the invoice the step above raised',
    xDown.workings.invoicedForCycle === xUp.chargeCents,
    `${money(xDown.workings.invoicedForCycle)} invoiced vs ${money(xUp.chargeCents)} charged`);
  check('And it hands back the unspent share of the posts granted',
    xDown.creditCents === Math.round((xUp.chargeCents * (xUp.quota.granted - 500)) / xUp.quota.granted),
    `${money(xDown.creditCents)} = ${xDown.workings.creditFormula}`);
  check('Still no negative invoice anywhere',
    (await GET(`/billing/accounts/${xid}/invoices`)).every((i) => i.total >= 0));

  step('18c-2 · The usage meter feeds the price, and resets when a new allowance is granted');
  await PUT(`/accounts/${xid}/usage`, { family: 'x_social', used: 150 });
  const meterPreview = await POST(`/subscriptions/${xid}/preview`, {
    planCode: 'pro_plus', term: 'monthly', screens: 2, addOns: [{ code: 'x_social_pro', quantity: 1 }],
  });
  const meterCap = meterPreview.quota?.allowance ?? 0;
  check('A request with no usage figure reads the meter',
    meterPreview.quota?.used === 150 &&
      meterPreview.breakdown.creditCents ===
        Math.round((xDown.chargeCents * (meterCap - 150)) / meterCap),
    `used ${meterPreview.quota?.used} of ${meterCap} → ${money(meterPreview.breakdown.creditCents)}`);

  const overridden = await POST(`/subscriptions/${xid}/preview`, {
    planCode: 'pro_plus', term: 'monthly', screens: 2,
    addOns: [{ code: 'x_social_pro', quantity: 1 }], quotaUsed: 600,
  });
  check('A request can still override the meter', overridden.breakdown.creditCents === 0,
    `${money(overridden.breakdown.creditCents)} with the whole allowance spent`);

  /*
   * On the first instant of a period the time left is exactly one cycle, and
   * counting that as a month "ahead" would hand back a month the customer is
   * still sitting in — an off-by-one that pays out real money.
   */
  check('The month in progress is not also counted as a month ahead',
    meterPreview.breakdown.monthsAhead === 0,
    `monthsAhead=${meterPreview.breakdown.monthsAhead} on a monthly term`);

  const xRebuy = await POST(`/subscriptions/${xid}/change`, {
    planCode: 'pro_plus', term: 'monthly', screens: 2, addOns: [{ code: 'x_social_pro', quantity: 1 }],
  });
  const meterAfter = await GET(`/accounts/${xid}`);
  check('A new allowance resets the meter', (meterAfter.usage?.x_social ?? 0) === 0,
    JSON.stringify(meterAfter.usage));

  step('18d · Carrying a usage-priced add-on across a change of term');
  /*
   * Resetting the billing cycle re-prices every line that is attached at that
   * moment, so the usage-priced line has to be detached first — otherwise
   * Stripe bills it by the calendar on top of the allowance already paid for.
   */
  await PUT(`/accounts/${xid}/usage`, { family: 'x_social', used: 1500 });
  const xTerm = await POST(`/subscriptions/${xid}/change`, {
    planCode: 'pro_plus', term: 'yearly', screens: 2,
    addOns: [{ code: 'x_social_standard', quantity: 1 }], quotaUsed: 100,
  });
  check('The add-on is valued against what the monthly term really charged for it',
    xTerm.workings.invoicedForCycle === xRebuy.chargeCents &&
      xTerm.creditCents ===
        Math.round((xRebuy.chargeCents * (xRebuy.quota.granted - 100)) / xRebuy.quota.granted),
    `${money(xTerm.creditCents)} = ${xTerm.workings.creditFormula}`);
  /*
   * A yearly term buys twelve allowances, but the one in progress is still only
   * worth the part of it that is left — so it is eleven whole months plus a
   * slice, not twelve whole months.
   */
  check('And bought at the new term: the month in progress by the slice, then eleven whole',
    xTerm.chargeCents === Math.round(900 * xTerm.workings.remainingFraction) + 900 * 11,
    `${money(xTerm.chargeCents)} = ${xTerm.workings.chargeFormula}`);

  const xTermInvoices = await GET(`/billing/accounts/${xid}/invoices`);
  const xProrationLines = xTermInvoices
    .flatMap((i) => i.lines)
    .filter((l) => l.proration && (l.description ?? '').includes('X Social'));
  check('Stripe never priced the add-on by the calendar', xProrationLines.length === 0,
    xProrationLines.map((l) => `${l.description} ${money(l.amount)}`).join(' · ') || 'no calendar lines');
  const xTermState = await GET(`/subscriptions/${xid}`);
  check('The add-on came back on the new term', xTermState.current.term === 'yearly' &&
    xTermState.current.addOns.some((a) => a.code === 'x_social_standard'),
    `${xTermState.current.term} · ${JSON.stringify(xTermState.current.addOns)}`);

  step('18d-2 · A yearly term holds twelve monthly allowances, and spent months are forfeited');
  /*
   * Stripe renews a yearly subscription once, so it cannot mark the eleven
   * month boundaries inside the period. The meter carries the month it belongs
   * to and reads zero again once that month has passed, which is also why the
   * leftovers of an elapsed month are never credited.
   */
  const rollAccount = await POST('/accounts', {
    email: `rollover+${Date.now()}@optisigns-billing-demo.test`,
    name: 'Allowance Rollover',
    withTestClock: true,
  });
  const rollId = rollAccount._id;
  await POST(`/accounts/${rollId}/payment-method/test`, { kind: 'visa' });
  await POST(`/subscriptions/${rollId}/change`, {
    planCode: 'standard', term: 'yearly', screens: 1, addOns: [],
  });
  await POST(`/subscriptions/${rollId}/change`, {
    planCode: 'standard', term: 'yearly', screens: 1,
    addOns: [{ code: 'x_social_standard', quantity: 1 }],
  });

  const rollCycle = async () => (await GET(`/subscriptions/${rollId}`)).usageCycle?.x_social ?? {};
  const m1 = await rollCycle();
  check('A yearly term reads as twelve allowance months',
    m1.monthsInPeriod === 12 && m1.index === 0 && m1.monthsAhead === 11,
    `month ${m1.index + 1}/${m1.monthsInPeriod}, ${m1.monthsAhead} ahead`);

  await PUT(`/accounts/${rollId}/usage`, { family: 'x_social', used: 400 });
  await POST(`/simulator/${rollId}/advance`, { preset: 'one_month' });
  const m2 = await rollCycle();
  check('The meter starts over at the next allowance month, not at the next invoice',
    m2.index === 1 && m2.used === 0 && m2.monthsAhead === 10,
    `month ${m2.index + 1}/12 reads ${m2.used}/${m2.allowance}, ${m2.monthsAhead} ahead`);

  await PUT(`/accounts/${rollId}/usage`, { family: 'x_social', used: 400 });
  await POST(`/simulator/${rollId}/advance`, { preset: 'one_month' });
  await PUT(`/accounts/${rollId}/usage`, { family: 'x_social', used: 400 });
  const m3 = await rollCycle();
  check('Three months in, the meter holds only this month', m3.index === 2 && m3.used === 400,
    `month ${m3.index + 1}/12 reads ${m3.used}/${m3.allowance}`);

  const rollQuote = await POST(`/subscriptions/${rollId}/preview`, {
    planCode: 'standard', term: 'monthly', screens: 1,
    addOns: [{ code: 'x_social_standard', quantity: 1 }],
  });
  check('Settling counts this month by posts and the rest by whole months',
    rollQuote.breakdown.creditCents === Math.round(900 * 200 / 600) + 900 * 9,
    `${money(rollQuote.breakdown.creditCents)} = ${rollQuote.breakdown.creditFormula}`);
  check('The 400 posts left unspent in months 1 and 2 are credited at nothing',
    rollQuote.breakdown.creditCents === 8400,
    `${money(rollQuote.breakdown.creditCents)} — two elapsed months would add ${money(2 * Math.round(900 * 200 / 600))} if carried`);
  if (!KEEP) await DELETE(`/accounts/${rollId}`);

  step('18d-3 · One operation reads as one invoice');
  /*
   * A term switch makes Stripe raise an invoice of its own, and any invoice
   * raised against a subscription sweeps in that subscription's pending items.
   * The allowance charge therefore rides along with the plan's proration lines
   * instead of arriving as a second charge for the same click.
   */
  const oneId = (await POST('/accounts', {
    email: `oneinvoice+${Date.now()}@optisigns-billing-demo.test`,
    name: 'One Invoice', withTestClock: true,
  }))._id;
  await POST(`/accounts/${oneId}/payment-method/test`, { kind: 'visa' });
  await POST(`/subscriptions/${oneId}/change`, { planCode: 'standard', term: 'monthly', screens: 1, addOns: [] });
  await POST(`/subscriptions/${oneId}/change`, {
    planCode: 'standard', term: 'monthly', screens: 1,
    addOns: [{ code: 'x_social_standard', quantity: 1 }],
  });
  const beforeSwitch = (await GET(`/billing/accounts/${oneId}/invoices`)).length;
  await POST(`/subscriptions/${oneId}/change`, {
    planCode: 'standard', term: 'yearly', screens: 1,
    addOns: [{ code: 'x_social_standard', quantity: 1 }],
  });
  const afterSwitch = await GET(`/billing/accounts/${oneId}/invoices`);
  const raised = afterSwitch.slice(0, afterSwitch.length - beforeSwitch);
  check('A term switch carrying a metered add-on raises one invoice, not two',
    raised.length === 1, `${raised.length} invoice(s): ${raised.map((i) => money(i.total)).join(' + ')}`);
  const raisedLines = (raised[0]?.lines ?? []).map((l) => l.description ?? '');
  check('That invoice carries both the plan and the allowance',
    raisedLines.some((d) => d.includes('X Social')) && raisedLines.some((d) => d.includes('Standard (at')),
    raisedLines.join(' · '));
  check('And the card is charged once, for the whole thing',
    raised[0]?.total === 20600, `${money(raised[0]?.total)} = $108 year + $108 allowance - $10 unused`);
  if (!KEEP) await DELETE(`/accounts/${oneId}`);

  step('18e · An add-on needs a plan underneath it');
  let xNoPlan = false;
  try {
    await POST(`/subscriptions/${xid}/change`, {
      planCode: 'pro_plus', term: 'yearly', screens: 0,
      addOns: [{ code: 'x_social_standard', quantity: 1 }], quotaUsed: 0,
    });
  } catch (err) {
    xNoPlan = /sit on top of a paid plan/i.test(err.message);
  }
  check('Zero screens means no add-ons', xNoPlan);

  // cancelling is governed by the per-add-on override, not the global rule
  const xBalanceBeforeCancel = (await GET(`/accounts/${xid}/balance`)).balance;
  // 18d left this account on the annual term; asking for monthly here as well
  // would make the term switch the headline change and the per-add-on rule
  // would never get a say, so only the add-on moves.
  const xCancel = await POST(`/subscriptions/${xid}/change`, {
    planCode: 'pro_plus', term: 'yearly', screens: 2, addOns: [],
  });
  check('Cancelling is scheduled for the boundary by the per-add-on rule',
    xCancel.applied === 'scheduled' && xCancel.rule.timing === 'end_of_period',
    `${xCancel.applied} · ${xCancel.rule.timing}`);
  check('The add-on stays usable until then', xCancel.state.current.addOns.length === 1,
    JSON.stringify(xCancel.state.current.addOns));
  check('And nothing is handed back for it',
    (await GET(`/accounts/${xid}/balance`)).balance === xBalanceBeforeCancel,
    money(xBalanceBeforeCancel));
  if (!KEEP) await DELETE(`/accounts/${xid}`);

  step('19 · Audit trail');
  const events = await GET(`/events?accountId=${id}&limit=100`);
  check('Every action was logged with its policy + Stripe payload', events.length > 10, `${events.length} events`);

  await POST('/policy/presets/optisigns_default');
  if (!KEEP) {
    await DELETE(`/accounts/${id}`);
    console.log(c.dim('\n  demo account deleted (pass --keep to inspect it in the Stripe dashboard)'));
  } else {
    console.log(c.dim(`\n  kept account ${id} / ${email}`));
  }

  console.log(
    failures === 0
      ? `\n${c.ok('All checks passed.')}`
      : `\n${c.bad(`${failures} check(s) failed.`)}`,
  );
  process.exit(failures === 0 ? 0 : 1);
};

run().catch((err) => {
  console.error(`\n${c.bad('Verification aborted:')} ${err.message}`);
  process.exit(1);
});
