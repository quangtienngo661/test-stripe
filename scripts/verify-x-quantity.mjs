#!/usr/bin/env node
/**
 * Quantity on the X Social add-on, end to end against real Stripe test objects.
 *
 * The add-on is sold per account in whole-number quantities with no ceiling
 * (MODEL V5 row 4). Quantity multiplies the price and the Monthly Post Updates
 * together, a month entered part-way through is bought by the slice that is
 * left (row 47), what is handed back is valued against what was really invoiced
 * (row 8), and anything that raises committed provider capacity has to pass the
 * admission guard before an invoice exists (rows 17, 48, 63).
 *
 * Usage: node scripts/verify-x-quantity.mjs [--keep]
 *
 * Run it alone: it moves the shared billing policy as it goes.
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
const money = (cents) => `$${((cents ?? 0) / 100).toFixed(2)}`;

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ${c.ok('✓')} ${label} ${c.dim(detail)}`);
  else { failures += 1; console.log(`  ${c.bad('✗')} ${label} ${c.warn(detail)}`); }
};
/** Clock arithmetic lands a second or two off an exact half; assert the shape, not the dust. */
const near = (label, actual, expected, tolerance, unit = '') =>
  check(label, Math.abs(actual - expected) <= tolerance,
    `got ${actual}${unit}, expected ≈${expected}${unit} (±${tolerance})`);

const call = async (method, path, body) => {
  const res = await fetch(`${API}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const m = json?.message?.message ?? json?.message ?? res.statusText;
    throw new Error(`${method} ${path} → ${res.status}: ${typeof m === 'string' ? m : JSON.stringify(m)}`);
  }
  return json;
};
const GET = (p) => call('GET', p), POST = (p, b) => call('POST', p, b),
      PUT = (p, b) => call('PUT', p, b), DELETE = (p) => call('DELETE', p);
const step = (t) => console.log(`\n${c.head(t)}`);
/** Runs `fn` and reports the rejection message, so a guard can be tested for *why* it refused. */
const expectRefusal = async (fn) => {
  try { await fn(); return null; } catch (e) { return e.message; }
};

const STD = 1000, STD_QUOTA = 600, PRO = 3000, PRO_QUOTA = 2000;
let id = null;

const run = async () => {
  step('0 · Environment');
  const catalog = await GET('/catalog');
  check('Stripe key configured', catalog.stripeConfigured);
  if (!catalog.stripeConfigured) process.exit(1);
  await POST('/catalog/sync-stripe');
  const std = catalog.addons.find((a) => a.code === 'x_social_standard');
  check('X Social Standard has no quantity ceiling', !std.maxQuantity, `maxQuantity=${std.maxQuantity ?? 'none'}`);
  check('Allowance is per unit of quantity', std.quotaAllowance === STD_QUOTA, String(std.quotaAllowance));

  await POST('/policy/presets/optisigns_default');

  step('1 · Account on a test clock, subscribed at the period start');
  const account = await POST('/accounts', {
    email: `xqty+${Date.now()}@optisigns-billing-demo.test`,
    name: 'X Quantity Bot', company: 'OptiSigns QA', withTestClock: true,
  });
  id = account._id;
  await POST(`/accounts/${id}/payment-method/test`, { kind: 'visa' });
  await POST(`/subscriptions/${id}/change`, { planCode: 'pro_plus', term: 'monthly', screens: 2, addOns: [] });
  let state = await GET(`/subscriptions/${id}`);
  const periodStart = state.stripe.currentPeriodStart, periodEnd = state.stripe.currentPeriodEnd;
  const periodLen = periodEnd - periodStart;
  check('Subscription active', state.stripe.status === 'active', state.stripe.status);

  step('2 · Buy 3 licences at the start of the month — price and quota both ×3');
  const invBefore = (await GET(`/billing/accounts/${id}/invoices`)).length;
  const bought = await POST(`/subscriptions/${id}/change`, {
    planCode: 'pro_plus', term: 'monthly', screens: 2,
    addOns: [{ code: 'x_social_standard', quantity: 3 }],
  });
  check('Quantity 3 accepted', true, 'no per-account ceiling any more');
  check('A first purchase is an add-on increase (row 47)', bought.ruleKey === 'addOnIncrease', bought.ruleKey);
  let invoices = await GET(`/billing/accounts/${id}/invoices`);
  const buyInvoice = invoices[0];
  near('Charged 3 × $10 for a whole month', buyInvoice.total, 3 * STD, 40, '¢');
  check('Invoice was collected', buyInvoice.status === 'paid', buyInvoice.status);
  state = await GET(`/subscriptions/${id}`);
  let meter = state.usageCycle.x_social;
  near('Allowance is 3 × 600', meter.allowance, 3 * STD_QUOTA, 30, ' posts');
  check('Quantity is on the subscription item', state.current.addOns[0].quantity === 3,
    JSON.stringify(state.current.addOns));
  check('One subscription item, not three', invoices.length - invBefore === 1, `${invoices.length - invBefore} invoice(s)`);

  step('3 · Halfway through the month, raise 3 → 5 licences');
  await POST(`/simulator/${id}/advance`, { seconds: Math.floor(periodLen / 2) });
  // spend some of the allowance so the hand-back has something to measure
  await PUT(`/accounts/${id}/usage`, { family: 'x_social', used: 900 });
  const upPreview = await POST(`/subscriptions/${id}/preview`, {
    planCode: 'pro_plus', term: 'monthly', screens: 2,
    addOns: [{ code: 'x_social_standard', quantity: 5 }],
  });
  /*
   * Buying more is additive: the three licences already held keep the 1,800
   * posts they were sold, and only the two new ones are priced — for the part
   * of the month that is left. Nothing is handed back and the meter does not
   * move, so a customer who buys more can never end up with less.
   */
  check('Buying more is an ordinary add-on increase, not a reconfiguration',
    upPreview.ruleKey === 'addOnIncrease' && upPreview.mode === 'quantity_delta',
    `${upPreview.ruleKey} · ${upPreview.mode}`);
  const w = upPreview.workings;
  const delta = 2;
  near('Preview prices the half-month left', w.remainingFraction * 100, 50, 3, '%');
  check('Charged for the two NEW licences only',
    w.chargeCents === Math.round(STD * delta * w.remainingFraction),
    `${money(w.chargeCents)} = ${w.chargeFormula}`);
  check('Quota added is for the new licences only',
    w.quotaAdded === Math.floor(STD_QUOTA * delta * w.remainingFraction),
    `+${w.quotaAdded} = ${w.quotaFormula}`);
  check('Nothing is handed back', w.creditCents === 0, money(w.creditCents));
  check('Allowance after = what was held + what was added',
    upPreview.quota.heldAfter === upPreview.quota.heldBefore + w.quotaAdded,
    `${upPreview.quota.heldBefore} + ${w.quotaAdded} = ${upPreview.quota.heldAfter}`);

  const balBeforeUp = (await GET(`/accounts/${id}/balance`)).balance;
  const up = await POST(`/subscriptions/${id}/change`, {
    planCode: 'pro_plus', term: 'monthly', screens: 2,
    addOns: [{ code: 'x_social_standard', quantity: 5 }],
  });
  state = await GET(`/subscriptions/${id}`);
  meter = state.usageCycle.x_social;
  const balAfterUp = (await GET(`/accounts/${id}/balance`)).balance;
  check('Quantity now 5', state.current.addOns[0].quantity === 5, JSON.stringify(state.current.addOns));
  check('Applied additively', up.applied === 'quantity_delta', up.applied);
  check('Allowance GREW — buying more never takes posts away',
    meter.allowance === 3 * STD_QUOTA + w.quotaAdded && meter.allowance > 3 * STD_QUOTA,
    `1800 → ${meter.allowance}`);
  check('The meter was not touched: 900 spent is still 900 spent',
    meter.used === 900, `used=${meter.used}`);
  check('No customer credit was created', balAfterUp === balBeforeUp,
    `${money(balBeforeUp)} → ${money(balAfterUp)}`);
  /*
   * The whole point of pricing the slice: a post costs the same whenever it was
   * bought, so the money paid across both purchases divided by the posts held
   * comes back to the list rate.
   */
  const paidSoFar = 3 * STD + w.chargeCents;
  check('Rate per post is unchanged across both purchases',
    Math.abs(paidSoFar / meter.allowance - STD / STD_QUOTA) < 0.01,
    `${(paidSoFar / meter.allowance).toFixed(3)}¢ vs ${(STD / STD_QUOTA).toFixed(3)}¢`);

  step('4 · Drop 5 → 2 licences: the reduction still runs the replace flow (row 8)');
  const balBefore = (await GET(`/accounts/${id}/balance`)).balance;
  const capBeforeDown = meter.allowance;
  await PUT(`/accounts/${id}/usage`, { family: 'x_social', used: 300 });
  const down = await POST(`/subscriptions/${id}/change`, {
    planCode: 'pro_plus', term: 'monthly', screens: 2,
    addOns: [{ code: 'x_social_standard', quantity: 2 }],
  });
  state = await GET(`/subscriptions/${id}`);
  const balAfter = (await GET(`/accounts/${id}/balance`)).balance;
  check('Quantity now 2', state.current.addOns[0].quantity === 2, JSON.stringify(state.current.addOns));
  check('A reduction still runs the replace flow', down.applied === 'usage_settlement', down.applied);
  check('Reduction produced customer credit', balAfter <= balBefore,
    `${money(balBefore)} → ${money(balAfter)}`);
  /*
   * The integration point: the hand-back has to be valued against EVERYTHING
   * invoiced for the family this month and measured against EVERY post granted
   * for it — both purchases, not just the last one. Overwriting either figure
   * instead of accumulating it silently robs the customer.
   */
  check('Credit is valued against both purchases, not just the last',
    down.workings.invoicedForCycle === paidSoFar,
    `${money(down.workings.invoicedForCycle)} invoiced vs ${money(paidSoFar)} really paid`);
  check('…and measured against the accumulated cap',
    down.workings.allowance === capBeforeDown, `${down.workings.allowance} vs ${capBeforeDown}`);
  check('Credit = invoiced × unspent share of that cap',
    down.creditCents === Math.round((paidSoFar * (capBeforeDown - 300)) / capBeforeDown),
    `${money(down.creditCents)} = ${down.workings.creditFormula}`);

  step('5 · Tier change keeps the quantity (row 51)');
  const tier = await POST(`/subscriptions/${id}/change`, {
    planCode: 'pro_plus', term: 'monthly', screens: 2,
    addOns: [{ code: 'x_social_pro', quantity: 2 }],
  });
  state = await GET(`/subscriptions/${id}`);
  check('Moved to Pro, still 2 licences',
    state.current.addOns[0].code === 'x_social_pro' && state.current.addOns[0].quantity === 2,
    JSON.stringify(state.current.addOns));
  check('Still one subscription item', state.current.addOns.length === 1, `${state.current.addOns.length} item(s)`);

  step('6 · Next month starts whole — the part-month grant does not persist');
  const nowBefore = state.usageCycle.x_social.cycleEnd;
  await POST(`/simulator/${id}/advance`, { to: nowBefore + 3600 });
  state = await GET(`/subscriptions/${id}`);
  meter = state.usageCycle.x_social;
  near('A whole month is 2 × 2,000', meter.allowance, 2 * PRO_QUOTA, 10, ' posts');
  check('Meter rolled to zero', meter.used === 0, `used=${meter.used}`);

  step('7 · Capacity guard: refuses what it cannot serve, allows giving back');
  const live = await GET(`/policy`);
  const committed = 2 * PRO_QUOTA;
  // put the ceiling just above what this account already holds
  await PUT('/policy', { constraints: { enforceCapacityGuard: true, capacityBlockAtUnits: committed + 1000 } });

  const refusal = await expectRefusal(() =>
    POST(`/subscriptions/${id}/change`, {
      planCode: 'pro_plus', term: 'monthly', screens: 2,
      addOns: [{ code: 'x_social_pro', quantity: 20 }],
    }));
  check('A quantity increase past the budget is refused', Boolean(refusal), refusal ?? 'not refused');
  check('The refusal names the provider budget', /provider budget/i.test(refusal ?? ''), refusal ?? '');
  state = await GET(`/subscriptions/${id}`);
  check('Nothing changed on the subscription', state.current.addOns[0].quantity === 2,
    JSON.stringify(state.current.addOns));
  const invNow = await GET(`/billing/accounts/${id}/invoices`);
  check('No invoice was raised for the refused change',
    !invNow.some((i) => i.status === 'open' && i.total > 10000), 'checked before the invoice exists');

  // row 63: giving capacity back never has to pass
  await PUT('/policy', { constraints: { capacityBlockAtUnits: 1 } });
  const shrink = await expectRefusal(() =>
    POST(`/subscriptions/${id}/change`, {
      planCode: 'pro_plus', term: 'monthly', screens: 2,
      addOns: [{ code: 'x_social_pro', quantity: 1 }],
    }));
  check('A reduction is allowed even below the ceiling', shrink === null, shrink ?? 'allowed');

  // and the guard can be switched off entirely
  await PUT('/policy', { constraints: { enforceCapacityGuard: false } });
  const off = await expectRefusal(() =>
    POST(`/subscriptions/${id}/change`, {
      planCode: 'pro_plus', term: 'monthly', screens: 2,
      addOns: [{ code: 'x_social_pro', quantity: 3 }],
    }));
  check('With the guard off the same increase goes through', off === null, off ?? 'allowed');

  await PUT('/policy', {
    constraints: {
      enforceCapacityGuard: true,
      capacityBlockAtUnits: live.policy?.constraints?.capacityBlockAtUnits ?? 2_400_000,
    },
  });

  step('8 · Giving the licence up runs to the boundary and hands nothing back (row 49)');
  /*
   * The preview of a scheduled change patches the live subscription, so the
   * item ids have to survive the trip and the removals have to travel with it.
   * Stripping the id turns a reprice into "add a second item at the same
   * price", which Stripe refuses; dropping the removal leaves the very line
   * being cancelled sitting in the renewal the customer is shown.
   */
  const dropPreview = await POST(`/subscriptions/${id}/preview`, {
    planCode: 'pro_plus', term: 'monthly', screens: 2, addOns: [],
  });
  check('The scheduled-change preview priced without error',
    !dropPreview.previewUnavailable && Boolean(dropPreview.invoice),
    dropPreview.previewUnavailable ?? 'renewal invoice returned');
  check('…and the renewal it shows has the add-on already gone',
    !(dropPreview.invoice?.lines ?? []).some((l) => (l.description ?? '').includes('X Social')),
    (dropPreview.invoice?.lines ?? []).map((l) => l.description).join(' · '));

  const balBeforeDrop = (await GET(`/accounts/${id}/balance`)).balance;
  const dropped = await POST(`/subscriptions/${id}/change`, {
    planCode: 'pro_plus', term: 'monthly', screens: 2, addOns: [],
  });
  check('Dropping the add-on is scheduled, not immediate', dropped.applied === 'scheduled', dropped.applied);
  check('It lands on the renewal boundary', dropped.effectiveAt === state.stripe.currentPeriodEnd,
    `${dropped.effectiveAt} vs ${state.stripe.currentPeriodEnd}`);
  state = await GET(`/subscriptions/${id}`);
  check('The licences stay usable until then', state.current.addOns[0]?.quantity === 3,
    JSON.stringify(state.current.addOns));
  check('The allowance stays on the meter', Boolean(state.usageCycle?.x_social),
    JSON.stringify(state.usageCycle?.x_social?.allowance));
  const balAfterDrop = (await GET(`/accounts/${id}/balance`)).balance;
  check('No money came back', balAfterDrop === balBeforeDrop, `${money(balBeforeDrop)} → ${money(balAfterDrop)}`);

  step('9 · The scheduled drop actually lands at the renewal');
  await POST(`/simulator/${id}/advance`, { to: state.stripe.currentPeriodEnd + 3600 });
  state = await GET(`/subscriptions/${id}`);
  check('Add-on gone after the boundary', (state.current.addOns ?? []).length === 0,
    JSON.stringify(state.current.addOns));
  check('Meter gone with it', !state.usageCycle?.x_social, JSON.stringify(state.usageCycle));

  step('10 · Yearly term: twelve allowances, each multiplied by the quantity');
  /*
   * A yearly term pays for twelve allowance months up front. Only the month in
   * progress is sold by the slice that is left; the eleven behind it are bought
   * whole, allowance and all.
   */
  await POST(`/subscriptions/${id}/change`, { planCode: 'pro_plus', term: 'yearly', screens: 2, addOns: [] });
  const yBuy = await POST(`/subscriptions/${id}/change`, {
    planCode: 'pro_plus', term: 'yearly', screens: 2,
    addOns: [{ code: 'x_social_standard', quantity: 3 }],
  });
  const yRate = 900 * 3; // annual per-month rate × licences
  check('Charged twelve whole allowance months at 3 licences',
    yBuy.chargeCents === yRate * 12, `${money(yBuy.chargeCents)} = ${yBuy.workings.chargeFormula}`);
  check('Eleven months lie ahead of the one in progress',
    yBuy.workings.monthsAhead === 11, `monthsAhead=${yBuy.workings.monthsAhead}`);
  check('The month in progress grants 600 × 3',
    yBuy.quota.granted === 600 * 3, `${yBuy.quota.granted} = ${yBuy.workings.quotaFormula}`);

  step('11 · Yearly, half a month in: raise 3 → 5 licences');
  const yCycle = (await GET(`/subscriptions/${id}`)).usageCycle.x_social;
  await POST(`/simulator/${id}/advance`, { seconds: Math.floor((yCycle.cycleEnd - yCycle.cycleStart) / 2) });
  await PUT(`/accounts/${id}/usage`, { family: 'x_social', used: 900 });
  const yUp = await POST(`/subscriptions/${id}/change`, {
    planCode: 'pro_plus', term: 'yearly', screens: 2,
    addOns: [{ code: 'x_social_standard', quantity: 5 }],
  });
  const yFrac = yUp.workings.remainingFraction;
  const yDelta = 2;
  check('Half of allowance month 1 is still ahead', Math.abs(yFrac - 0.5) < 0.03, `${(yFrac * 100).toFixed(1)}%`);
  check('An annual increase is additive too', yUp.applied === 'quantity_delta', yUp.applied);
  check('Nothing handed back', yUp.creditCents === 0, money(yUp.creditCents));
  /*
   * The annual split still applies to the new licences: the month in progress
   * by its remaining slice, the eleven months behind it whole.
   */
  check('New licences: the slice of month 1 + eleven whole months',
    yUp.chargeCents === Math.round(900 * yDelta * yFrac) + 900 * yDelta * 11,
    `${money(yUp.chargeCents)} = ${yUp.workings.chargeFormula}`);
  check('Posts added for month 1 are cut by the same fraction',
    yUp.quota.added === Math.floor(600 * yDelta * yFrac),
    `+${yUp.quota.added} = ${yUp.workings.quotaFormula}`);
  const yState = await GET(`/subscriptions/${id}`);
  check('Annual allowance grew rather than being replaced',
    yState.usageCycle.x_social.allowance === 1800 + yUp.quota.added,
    `1800 → ${yState.usageCycle.x_social.allowance}`);
  check('The annual meter was not reset either',
    yState.usageCycle.x_social.used === 900, `used=${yState.usageCycle.x_social.used}`);

  step('12 · A running trial counts against committed capacity (row 17)');
  // no card on file, so the trial policy applies to this one
  const trialAcc = await POST('/accounts', {
    email: `xtrial+${Date.now()}@optisigns-billing-demo.test`,
    name: 'Trial Bot', company: 'OptiSigns QA', withTestClock: true,
  });
  await POST(`/subscriptions/${trialAcc._id}/change`, {
    planCode: 'pro_plus', term: 'monthly', screens: 1, addOns: [],
  });
  const trialState = await GET(`/subscriptions/${trialAcc._id}`);
  check('The second account really is on trial', trialState.stripe.status === 'trialing',
    trialState.stripe.status);

  const withTrial = await POST(`/subscriptions/${id}/preview`, {
    planCode: 'pro_plus', term: 'yearly', screens: 2,
    addOns: [{ code: 'x_social_standard', quantity: 5 }],
  });
  await DELETE(`/accounts/${trialAcc._id}`);
  const withoutTrial = await POST(`/subscriptions/${id}/preview`, {
    planCode: 'pro_plus', term: 'yearly', screens: 2,
    addOns: [{ code: 'x_social_standard', quantity: 5 }],
  });
  check('Dropping the trial releases exactly the nominal trial units',
    withTrial.capacity.projected - withoutTrial.capacity.projected === 200,
    `${withTrial.capacity.projected} → ${withoutTrial.capacity.projected}`);
  check('This account still contributes 600 × 5',
    withoutTrial.capacity.projected >= 600 * 5, String(withoutTrial.capacity.projected));

  step('13 · Mid-year change bills only the months actually left (MODEL V5 row 8)');
  /*
   * Regression guard. The whole-month count used to be hard-wired to eleven, so
   * a change made in month four of a year re-billed three months the customer
   * had already paid for. The count has to follow the period that is really
   * left, and the annual worked example in row 8 is the reference: credit
   * $236.25, charge $76.94.
   */
  const annual = await POST('/accounts', {
    email: `xann+${Date.now()}@optisigns-billing-demo.test`,
    name: 'Annual Bot', company: 'OptiSigns QA', withTestClock: true,
  });
  const aid = annual._id;
  await POST(`/accounts/${aid}/payment-method/test`, { kind: 'visa' });
  await POST(`/subscriptions/${aid}/change`, { planCode: 'pro_plus', term: 'yearly', screens: 1, addOns: [] });
  await POST(`/subscriptions/${aid}/change`, {
    planCode: 'pro_plus', term: 'yearly', screens: 1, addOns: [{ code: 'x_social_pro', quantity: 1 }],
  });
  await POST(`/simulator/${aid}/advance`, { seconds: 105 * 86400 }); // ~3.5 months in
  await PUT(`/accounts/${aid}/usage`, { family: 'x_social', used: 500 });
  const midYear = await POST(`/subscriptions/${aid}/preview`, {
    planCode: 'pro_plus', term: 'yearly', screens: 1, addOns: [{ code: 'x_social_standard', quantity: 1 }],
  });
  const mw = midYear.workings;
  check('Four months in, eight lie ahead', mw.monthsAhead === 8, `monthsAhead=${mw.monthsAhead}`);
  check('Whole months billed = months left, not a hard-wired eleven',
    mw.chargeCents === Math.round(900 * mw.remainingFraction) + 900 * mw.monthsAhead,
    `${money(mw.chargeCents)} = ${mw.chargeFormula}`);
  check('Credit matches the annual worked example to the cent',
    mw.creditCents === 23625, `${money(mw.creditCents)} (spec says $236.25)`);
  check('Charge matches the annual worked example to the cent',
    mw.chargeCents === 7694, `${money(mw.chargeCents)} (spec says $76.94)`);
  await DELETE(`/accounts/${aid}`);

  step('14 · Several increases in one month each stand on their own');
  const multi = await POST('/accounts', {
    email: `xmulti+${Date.now()}@optisigns-billing-demo.test`,
    name: 'Multi Bot', company: 'OptiSigns QA', withTestClock: true,
  });
  const mid = multi._id;
  await POST(`/accounts/${mid}/payment-method/test`, { kind: 'visa' });
  await POST(`/subscriptions/${mid}/change`, { planCode: 'pro_plus', term: 'monthly', screens: 2, addOns: [] });
  const mLen = (await GET(`/subscriptions/${mid}`)).stripe.currentPeriodEnd
    - (await GET(`/subscriptions/${mid}`)).stripe.currentPeriodStart;
  await POST(`/subscriptions/${mid}/change`, {
    planCode: 'pro_plus', term: 'monthly', screens: 2, addOns: [{ code: 'x_social_standard', quantity: 4 }],
  });
  let mCap = (await GET(`/subscriptions/${mid}`)).usageCycle.x_social.allowance;
  let mPaid = 4 * STD;
  for (const [advance, to] of [[mLen / 4, 6], [mLen / 4, 9]]) {
    await POST(`/simulator/${mid}/advance`, { seconds: Math.floor(advance) });
    const before = (await GET(`/subscriptions/${mid}`)).usageCycle.x_social.allowance;
    const r = await POST(`/subscriptions/${mid}/change`, {
      planCode: 'pro_plus', term: 'monthly', screens: 2,
      addOns: [{ code: 'x_social_standard', quantity: to }],
    });
    const after = (await GET(`/subscriptions/${mid}`)).usageCycle.x_social.allowance;
    mPaid += r.chargeCents;
    mCap = after;
    check(`Raising to ${to} adds on top of what was already granted`,
      after === before + r.quota.added && after > before, `${before} + ${r.quota.added} = ${after}`);
    check(`…priced on the fraction left at that moment, not from the start`,
      r.chargeCents === Math.round(STD * r.workings.delta * r.workings.remainingFraction),
      `${money(r.chargeCents)} = ${r.workings.chargeFormula}`);
  }
  const mDown = await POST(`/subscriptions/${mid}/preview`, {
    planCode: 'pro_plus', term: 'monthly', screens: 2, addOns: [{ code: 'x_social_standard', quantity: 1 }],
  });
  check('All three purchases are counted when value is handed back',
    mDown.workings.invoicedForCycle === mPaid && mDown.workings.allowance === mCap,
    `${money(mDown.workings.invoicedForCycle)} of ${money(mPaid)} · cap ${mDown.workings.allowance} of ${mCap}`);

  step('15 · Too little of the month left to sell any allowance');
  /*
   * Down to the last minutes of the month one more licence would buy zero
   * posts. Charging for nothing would break the one rule this add-on rests on,
   * so the licence starts with the next allowance month instead — free.
   */
  const endCycle = (await GET(`/subscriptions/${mid}`)).usageCycle.x_social;
  await POST(`/simulator/${mid}/advance`, { to: endCycle.cycleEnd - 20 });
  const sliver = await POST(`/subscriptions/${mid}/preview`, {
    planCode: 'pro_plus', term: 'monthly', screens: 2, addOns: [{ code: 'x_social_standard', quantity: 10 }],
  });
  check('No posts can be sold this late', sliver.quota.added === 0, `+${sliver.quota.added}`);
  check('So nothing is charged for them', sliver.breakdown.chargeCents === 0,
    money(sliver.breakdown.chargeCents));
  check('And the explanation says they start next month',
    sliver.workings.startsNextMonth === true, String(sliver.workings.startsNextMonth));

  step('16 · The replace flow still owns tier changes (row 8 untouched)');
  await POST(`/simulator/${mid}/advance`, { to: endCycle.cycleEnd + 3600 });
  await PUT(`/accounts/${mid}/usage`, { family: 'x_social', used: 100 });
  const tierUp = await POST(`/subscriptions/${mid}/preview`, {
    planCode: 'pro_plus', term: 'monthly', screens: 2, addOns: [{ code: 'x_social_pro', quantity: 9 }],
  });
  check('Standard → Pro is still a reconfiguration, not a delta',
    tierUp.mode === 'usage_settlement' && tierUp.ruleKey === 'addOnTierChange',
    `${tierUp.mode} · ${tierUp.ruleKey}`);
  check('…and it still hands the unspent allowance back',
    tierUp.breakdown.creditCents > 0, money(tierUp.breakdown.creditCents));
  await DELETE(`/accounts/${mid}`);

  step('17 · A parked cancellation can be called off before it lands (row 49)');
  const undo = await POST('/accounts', {
    email: `xundo+${Date.now()}@optisigns-billing-demo.test`,
    name: 'Undo Bot', company: 'OptiSigns QA', withTestClock: true,
  });
  const uid = undo._id;
  await POST(`/accounts/${uid}/payment-method/test`, { kind: 'visa' });
  await POST(`/subscriptions/${uid}/change`, {
    planCode: 'pro_plus', term: 'monthly', screens: 2, addOns: [{ code: 'x_social_standard', quantity: 3 }],
  });
  await PUT(`/accounts/${uid}/usage`, { family: 'x_social', used: 400 });
  const balUndo = (await GET(`/accounts/${uid}/balance`)).balance;
  const invUndo = (await GET(`/billing/accounts/${uid}/invoices`)).length;

  const parked = await POST(`/subscriptions/${uid}/change`, {
    planCode: 'pro_plus', term: 'monthly', screens: 2, addOns: [],
  });
  check('The drop is parked on a schedule', parked.applied === 'scheduled', parked.applied);
  /*
   * Re-selecting the add-on cannot undo this: while the drop is parked the live
   * subscription still holds it, so the request reads as no change at all and
   * the schedule survives. That is exactly why row 49 needs its own way back.
   */
  const reselect = await POST(`/subscriptions/${uid}/change`, {
    planCode: 'pro_plus', term: 'monthly', screens: 2, addOns: [{ code: 'x_social_standard', quantity: 3 }],
  });
  check('Re-selecting the add-on is a no-op and leaves the schedule standing',
    reselect.noop === true && Boolean((await GET(`/subscriptions/${uid}`)).account.stripeScheduleId),
    reselect.message ?? 'schedule still there');

  const calledOff = await POST(`/subscriptions/${uid}/cancel-scheduled-change`);
  check('Calling it off releases the schedule',
    !calledOff.account.stripeScheduleId && !calledOff.account.pendingChange,
    `schedule=${calledOff.account.stripeScheduleId} pending=${JSON.stringify(calledOff.account.pendingChange)}`);
  check('The licences are still held, untouched',
    calledOff.current.addOns[0]?.code === 'x_social_standard' && calledOff.current.addOns[0]?.quantity === 3,
    JSON.stringify(calledOff.current.addOns));
  check('The meter is left exactly as it was', calledOff.usageCycle.x_social.used === 400,
    `used=${calledOff.usageCycle.x_social.used}`);
  check('No money moved either way',
    (await GET(`/accounts/${uid}/balance`)).balance === balUndo &&
      (await GET(`/billing/accounts/${uid}/invoices`)).length === invUndo,
    `balance ${money(balUndo)}, ${invUndo} invoice(s)`);

  const afterBoundary = await GET(`/subscriptions/${uid}`);
  await POST(`/simulator/${uid}/advance`, { to: afterBoundary.stripe.currentPeriodEnd + 3600 });
  const survived = await GET(`/subscriptions/${uid}`);
  check('And the add-on survives the renewal it was going to end at',
    survived.current.addOns[0]?.quantity === 3, JSON.stringify(survived.current.addOns));

  const noSchedule = await expectRefusal(() => POST(`/subscriptions/${uid}/cancel-scheduled-change`));
  check('Calling off nothing is refused with a plain message',
    /no scheduled change/i.test(noSchedule ?? ''), noSchedule ?? 'not refused');
  await DELETE(`/accounts/${uid}`);
};

run()
  .catch((err) => { failures += 1; console.log(`\n${c.bad('FAILED')} ${err.message}`); })
  .finally(async () => {
    if (id && !KEEP) { try { await DELETE(`/accounts/${id}`); } catch {} }
    await POST('/policy/presets/optisigns_default').catch(() => {});
    console.log(failures === 0 ? `\n${c.ok('All checks passed.')}` : `\n${c.bad(`${failures} check(s) failed.`)}`);
    process.exit(failures === 0 ? 0 : 1);
  });
