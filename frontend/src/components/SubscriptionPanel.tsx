import { useEffect, useMemo, useState } from 'react';
import { api, day, money } from '../api';

export default function SubscriptionPanel({ accountId, catalog, state, run, busy }: any) {
  const [draft, setDraft] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [overrides, setOverrides] = useState<any>({});
  // null = follow the billing policy, true/false = the operator decided
  const [trialChoice, setTrialChoice] = useState<boolean | null>(null);
  // how much of a metered add-on's allowance is spent; the billing engine needs
  // it to price the unused part when switching tiers, so it is editable right
  // here rather than only on the sidebar meter
  const [usedDraft, setUsedDraft] = useState<Record<string, string>>({});
  const currency = catalog?.currency ?? 'usd';

  const storedUsage = JSON.stringify(state?.account?.usage ?? {});
  useEffect(() => {
    const usage = state?.account?.usage ?? {};
    setUsedDraft(Object.fromEntries(Object.keys(usage).map((f) => [f, String(usage[f] ?? 0)])));
  }, [storedUsage]);

  // Reset the draft whenever the live subscription changes.
  useEffect(() => {
    if (!state?.current) return;
    setDraft({
      planCode: state.current.planCode,
      term: state.current.term,
      screens: state.current.screens,
      addOns: Object.fromEntries(state.current.addOns.map((a: any) => [a.code, a.quantity])),
    });
    setPreview(null);
    setPreviewError(null);
  }, [state?.current?.planCode, state?.current?.term, state?.current?.screens, JSON.stringify(state?.current?.addOns)]);

  const desired = useMemo(() => {
    if (!draft) return null;
    return {
      planCode: draft.planCode,
      term: draft.term,
      screens: Number(draft.screens) || 0,
      addOns: Object.entries(draft.addOns ?? {})
        .filter(([, q]: any) => Number(q) > 0)
        .map(([code, quantity]: any) => ({ code, quantity: Number(quantity) })),
      overrides: Object.keys(overrides).length ? overrides : undefined,
      ...(trialChoice === null ? {} : { withTrial: trialChoice }),
    };
  }, [draft, overrides, trialChoice]);

  const dirty = useMemo(() => {
    if (!desired || !state?.current) return false;
    const a = JSON.stringify({ ...desired, overrides: undefined, withTrial: undefined });
    const b = JSON.stringify({
      planCode: state.current.planCode,
      term: state.current.term,
      screens: state.current.screens,
      addOns: state.current.addOns,
    });
    return a !== b;
  }, [desired, state]);

  // Ask Stripe for the exact invoice this change would create.
  useEffect(() => {
    if (!desired || !accountId) return;
    if (!dirty && state?.stripe) {
      setPreview(null);
      return;
    }
    const handle = setTimeout(async () => {
      setPreviewing(true);
      setPreviewError(null);
      try {
        setPreview(await api.preview(accountId, desired));
      } catch (err: any) {
        setPreview(null);
        setPreviewError(err.message);
      } finally {
        setPreviewing(false);
      }
    }, 450);
    return () => clearTimeout(handle);
  }, [JSON.stringify(desired), dirty, accountId]);

  if (!catalog || !draft || !state) return <div className="empty">Loading…</div>;

  // A cancelled subscription still comes back from Stripe, but nothing can be
  // done to it any more — starting a plan again creates a fresh one.
  const LIVE_STATUSES = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'];
  const isLive = Boolean(state.stripe && LIVE_STATUSES.includes(state.stripe.status));

  const plans = catalog.plans ?? [];
  const addons = catalog.addons ?? [];
  // tiered add-ons are picked one tier at a time, per-unit ones get a stepper
  const perUnitAddons = addons.filter((a: any) => !a.family);
  const tieredFamilies = Object.values(
    addons
      .filter((a: any) => a.family)
      .reduce((acc: any, a: any) => {
        acc[a.family] = acc[a.family] ?? { family: a.family, tiers: [] };
        acc[a.family].tiers.push(a);
        acc[a.family].tiers.sort((x: any, y: any) => x.tierRank - y.tierRank);
        return acc;
      }, {}),
  );
  const activePlan = plans.find((p: any) => p.code === draft.planCode);
  const perScreen = draft.term === 'yearly' ? activePlan?.annualMonthlyCents : activePlan?.monthlyCents;

  const monthlyTotal =
    (perScreen ?? 0) * (Number(draft.screens) || 0) +
    addons.reduce((sum: number, addon: any) => {
      const qty = Number(draft.addOns?.[addon.code] ?? 0);
      const unit = draft.term === 'yearly' ? addon.annualMonthlyCents : addon.monthlyCents;
      return sum + unit * qty;
    }, 0);

  return (
    <div className="grid-2">
      <section className="card">
        <h2>Configure the subscription</h2>

        <div className="field">
          <label>Billing term</label>
          <div className="segmented">
            {['monthly', 'yearly'].map((term) => (
              <button
                key={term}
                className={draft.term === term ? 'seg active' : 'seg'}
                onClick={() => setDraft({ ...draft, term })}
              >
                {term === 'monthly' ? 'Monthly' : `Yearly (−${catalog.annualDiscountPercent}%)`}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label>Plan</label>
          <div className="plan-list">
            {plans.map((plan: any) => {
              const unit = draft.term === 'yearly' ? plan.annualMonthlyCents : plan.monthlyCents;
              return (
                <button
                  key={plan.code}
                  className={draft.planCode === plan.code ? 'plan selected' : 'plan'}
                  onClick={() => {
                    // keep the draft legal for the plan just picked: Free caps at 3
                    // screens and takes no add-ons, Enterprise needs at least 25.
                    const min = plan.minQuantity ?? 0;
                    const max = plan.maxQuantity ?? Number.MAX_SAFE_INTEGER;
                    const screens = Math.min(Math.max(Number(draft.screens) || 0, min), max);
                    setDraft({
                      ...draft,
                      planCode: plan.code,
                      screens,
                      addOns: plan.code === 'free' ? {} : draft.addOns,
                    });
                  }}
                >
                  <div className="plan-head">
                    <strong>{plan.name}</strong>
                    <span>{unit === 0 ? 'Free' : `${money(unit, currency)} / screen / mo`}</span>
                  </div>
                  <span className="plan-note">
                    {plan.minQuantity > 1 ? `min ${plan.minQuantity} screens · ` : ''}
                    {plan.features.slice(0, 2).join(' · ')}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="field">
          <label>Screens</label>
          <div className="stepper">
            <button onClick={() => setDraft({ ...draft, screens: Math.max(0, Number(draft.screens) - 1) })}>−</button>
            <input
              type="number"
              min={0}
              value={draft.screens}
              onChange={(e) => setDraft({ ...draft, screens: Math.max(0, Number(e.target.value)) })}
            />
            <button onClick={() => setDraft({ ...draft, screens: Number(draft.screens) + 1 })}>+</button>
          </div>
        </div>

        <div className="field">
          <label>Metered add-ons</label>
          {tieredFamilies.map(({ family, tiers }: any) => {
            const activeCode = tiers.find((t: any) => Number(draft.addOns?.[t.code] ?? 0) > 0)?.code ?? null;
            const qty = activeCode ? Number(draft.addOns?.[activeCode] ?? 0) : 0;
            const setQty = (n: number) =>
              activeCode &&
              setDraft({ ...draft, addOns: { ...draft.addOns, [activeCode]: Math.max(1, n) } });
            const liveCode = (state.current.addOns ?? []).find((a: any) =>
              tiers.some((t: any) => t.code === a.code),
            )?.code ?? null;
            const liveTier = tiers.find((t: any) => t.code === liveCode);
            const switching = Boolean(liveCode && activeCode && liveCode !== activeCode);
            const termSwitching = Boolean(liveCode && activeCode && draft.term !== state.current.term);
            return (
              <div className="tiered" key={family}>
                <div className="segmented">
                  <button
                    className={activeCode === null ? 'seg active' : 'seg'}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        addOns: Object.fromEntries(
                          Object.entries(draft.addOns ?? {}).filter(([c]) => !tiers.some((t: any) => t.code === c)),
                        ),
                      })
                    }
                  >
                    Off
                  </button>
                  {tiers.map((t: any) => (
                    <button
                      key={t.code}
                      className={activeCode === t.code ? 'seg active' : 'seg'}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          addOns: {
                            ...Object.fromEntries(
                              Object.entries(draft.addOns ?? {}).filter(([c]) => !tiers.some((x: any) => x.code === c)),
                            ),
                            // a tier switch reprices the licences held, it does not reset them
                            [t.code]: Math.max(1, qty),
                          },
                        })
                      }
                    >
                      {t.name.replace(/^X Social /, '')}
                    </button>
                  ))}
                </div>
                {activeCode && (
                  <div className="addon-row">
                    <span className="mini">licences</span>
                    <button className="ghost small" disabled={qty <= 1} onClick={() => setQty(qty - 1)}>
                      −
                    </button>
                    <input
                      type="number"
                      min={1}
                      value={qty}
                      onChange={(e) => setQty(Math.floor(Number(e.target.value) || 1))}
                    />
                    <button className="ghost small" onClick={() => setQty(qty + 1)}>
                      +
                    </button>
                    <span className="mini">
                      × {(tiers.find((t: any) => t.code === activeCode)?.quotaAllowance ?? 0).toLocaleString()} ={' '}
                      {(
                        (tiers.find((t: any) => t.code === activeCode)?.quotaAllowance ?? 0) * qty
                      ).toLocaleString()}{' '}
                      {tiers.find((t: any) => t.code === activeCode)?.quotaLabel ?? ''} / month
                    </span>
                  </div>
                )}
                <div className="plan-note">
                  {tiers
                    .map(
                      (t: any) =>
                        `${t.name.replace(/^X Social /, '')} ${money(
                          draft.term === 'yearly' ? t.annualMonthlyCents : t.monthlyCents,
                          currency,
                        )}/mo · ${t.quotaAllowance?.toLocaleString()} ${t.quotaLabel ?? ''}`,
                    )
                    .join(' — ')}
                </div>
                {liveCode && (
                  <div className="quota-box">
                    <span className="mini">
                      {liveTier?.quotaLabel ?? 'allowance'} spent on {liveTier?.name}
                    </span>
                    <span className="quota-edit">
                      <input
                        type="number"
                        min={0}
                        max={state.usageCycle?.[family]?.allowance ?? liveTier?.quotaAllowance}
                        value={usedDraft[family] ?? String(state.usageCycle?.[family]?.used ?? state.account.usage?.[family] ?? 0)}
                        onChange={(e) => setUsedDraft({ ...usedDraft, [family]: e.target.value })}
                      />
                      <span className="mini">
                        / {(state.usageCycle?.[family]?.allowance ?? liveTier?.quotaAllowance ?? 0).toLocaleString()}
                      </span>
                      <button
                        className="ghost small"
                        disabled={(() => {
                          const live = state.usageCycle?.[family]?.used ?? state.account.usage?.[family] ?? 0;
                          return busy || usedDraft[family] === '' || Number(usedDraft[family] ?? live) === live;
                        })()}
                        onClick={() =>
                          run(
                            () => api.setUsage(accountId, family, Number(usedDraft[family])),
                            `${liveTier?.quotaLabel}: ${Number(usedDraft[family]).toLocaleString()} spent`,
                          )
                        }
                      >
                        Save
                      </button>
                    </span>
                    <span className="plan-note">
                      {switching || termSwitching
                        ? 'whatever is left becomes account credit'
                        : state.usageCycle?.[family]?.monthsInPeriod > 1
                          ? `month ${state.usageCycle[family].index + 1} of ${state.usageCycle[family].monthsInPeriod} — type how many posts went out, then Save`
                          : 'type how many posts went out, then Save'}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="field">
          <label>Per-unit add-ons</label>
          {perUnitAddons.map((addon: any) => {
            const unit = draft.term === 'yearly' ? addon.annualMonthlyCents : addon.monthlyCents;
            const qty = Number(draft.addOns?.[addon.code] ?? 0);
            return (
              <div key={addon.code} className="addon">
                <div>
                  <strong>{addon.name}</strong>
                  <span className="plan-note">
                    {money(unit, currency)} / {addon.unitLabel} / mo
                    {addon.boundToScreens ? ' · max = screen count' : ''}
                  </span>
                </div>
                <div className="stepper small">
                  <button
                    onClick={() =>
                      setDraft({ ...draft, addOns: { ...draft.addOns, [addon.code]: Math.max(0, qty - 1) } })
                    }
                  >
                    −
                  </button>
                  <input
                    type="number"
                    min={0}
                    value={qty}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        addOns: { ...draft.addOns, [addon.code]: Math.max(0, Number(e.target.value)) },
                      })
                    }
                  />
                  <button
                    onClick={() => setDraft({ ...draft, addOns: { ...draft.addOns, [addon.code]: qty + 1 } })}
                  >
                    +
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="total">
          <span>Contract value</span>
          <strong>
            {money(monthlyTotal, currency)} / month
            {draft.term === 'yearly' ? ` · ${money(monthlyTotal * 12, currency)} billed yearly` : ''}
          </strong>
        </div>

        {!isLive && (
          <div className="field trial-box">
            <label>Trial</label>
            <label className="check">
              <input
                type="checkbox"
                checked={trialChoice ?? preview?.trial?.willApply ?? false}
                onChange={(e) => setTrialChoice(e.target.checked)}
              />
              Start this subscription with a trial
              {trialChoice === null && <span className="tag">following policy</span>}
            </label>
            <p className="hint">
              {preview?.trial?.error
                ? preview.trial.error
                : preview?.trial
                  ? `${preview.trial.willApply ? `${preview.trial.days}-day trial` : 'No trial'} — ${preview.trial.reason}`
                  : 'The billing policy decides unless you tick the box.'}
            </p>
            {trialChoice !== null && (
              <button className="ghost small" onClick={() => setTrialChoice(null)}>
                back to policy default
              </button>
            )}
          </div>
        )}

        <details className="overrides">
          <summary>One-off policy override for this change</summary>
          <p className="hint">
            Leave empty to use the active billing policy. Anything set here applies to this single change only —
            handy for showing two behaviours side by side.
          </p>
          {[
            ['timing', ['', 'immediate', 'end_of_period']],
            ['prorationBehavior', ['', 'create_prorations', 'always_invoice', 'none']],
            ['billingCycleAnchor', ['', 'unchanged', 'now']],
            ['creditHandling', ['', 'customer_balance', 'push_to_account_balance', 'refund_to_payment_method', 'none']],
          ].map(([key, options]: any) => (
            <div className="row" key={key}>
              <label className="mini">{key}</label>
              <select
                value={overrides[key] ?? ''}
                onChange={(e) => {
                  const next = { ...overrides };
                  if (e.target.value) next[key] = e.target.value;
                  else delete next[key];
                  setOverrides(next);
                }}
              >
                {options.map((o: string) => (
                  <option key={o} value={o}>
                    {o || '(use policy)'}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </details>

        <div className="row top-gap">
          <button
            disabled={busy || !dirty}
            onClick={() => run(() => api.change(accountId, desired), 'Change applied through Stripe')}
          >
            {state.stripe ? 'Apply change' : 'Start subscription'}
          </button>
          <button
            className="ghost"
            disabled={!dirty}
            onClick={() =>
              setDraft({
                planCode: state.current.planCode,
                term: state.current.term,
                screens: state.current.screens,
                addOns: Object.fromEntries(state.current.addOns.map((a: any) => [a.code, a.quantity])),
              })
            }
          >
            Reset
          </button>
        </div>
      </section>

      <div className="stack">
        <section className="card">
          <h2>What Stripe will do</h2>
          {previewing && <p className="hint">Asking Stripe for a preview…</p>}
          {previewError && <p className="error-text">{previewError}</p>}
          {!dirty && !previewError && <p className="hint">Change something on the left to see the proration preview.</p>}

          {preview && (
            <>
              <div className="rule-box">
                <span className="pill">{preview.ruleKey ?? preview.mode}</span>
                <ul>
                  {(preview.explanation ?? []).map((line: string, i: number) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </div>

              {/*
                Committed provider capacity is a platform-wide figure, so nothing
                on this account shows how close a change is to the ceiling. A
                refusal would otherwise arrive with no warning at all.
              */}
              {preview.capacity && (
                <div className="rule-box">
                  <span className={`pill ${preview.capacity.blocked ? 'warn' : preview.capacity.warning ? 'warn' : 'ok'}`}>
                    provider capacity
                  </span>
                  <ul>
                    <li>
                      After this change: <strong>{preview.capacity.projected.toLocaleString()}</strong> post
                      updates a month committed across the platform
                      {preview.capacity.projected !== preview.capacity.before && (
                        <> (now {preview.capacity.before.toLocaleString()})</>
                      )}
                      .
                    </li>
                    {preview.capacity.blocked && <li className="error-text">{preview.capacity.blocked}</li>}
                    {preview.capacity.warning && <li>{preview.capacity.warning}</li>}
                  </ul>
                </div>
              )}

              {!preview.invoice && preview.previewUnavailable && (
                <p className="hint">{preview.previewUnavailable}</p>
              )}

              {preview.mode === 'usage_settlement' && preview.breakdown && (
                <table className="lines">
                  <tbody>
                    {preview.breakdown.creditCents > 0 && (
                      <tr>
                        <td>
                          Unspent {preview.quota?.label ?? 'allowance'} returned
                          <div className="period">
                            {preview.quota?.unused} of {preview.quota?.allowance} · {preview.breakdown.creditFormula}
                          </div>
                        </td>
                        <td className="right credit">−{money(preview.breakdown.creditCents, currency)}</td>
                      </tr>
                    )}
                    <tr>
                      <td>
                        {/*
                          The new configuration is sold by the slice of the month
                          that is left, not at full price — saying otherwise
                          contradicts the formula printed directly underneath.
                        */}
                        {preview.breakdown.remainingFraction !== undefined &&
                        preview.breakdown.remainingFraction < 0.999
                          ? 'New configuration, priced for the rest of the month'
                          : 'New configuration, a whole allowance month'}
                        <div className="period">{preview.breakdown.chargeFormula}</div>
                      </td>
                      <td className="right">{money(preview.breakdown.chargeCents, currency)}</td>
                    </tr>
                    {preview.breakdown.existingCreditCents > 0 && (
                      <tr>
                        <td>Credit already on the account</td>
                        <td className="right credit">
                          −{money(preview.breakdown.existingCreditCents, currency)}
                        </td>
                      </tr>
                    )}
                  </tbody>
                  <tfoot>
                    <tr className="grand">
                      <td>Charged to the card now</td>
                      <td className="right">{money(preview.breakdown.dueNowCents, currency)}</td>
                    </tr>
                  </tfoot>
                </table>
              )}

              {preview.mode === 'schedule' && (
                <p className="hint">
                  Below is <strong>one full billing period at the new configuration</strong>, effective{' '}
                  {day(preview.effectiveAt)}. Stripe prices it against the current period, so the per-line dates are
                  its own reference frame — the amounts are what matters here.
                </p>
              )}

              {preview.invoice && (
                <table className="lines">
                  <thead>
                    <tr>
                      <th>Line</th>
                      <th>Qty</th>
                      <th className="right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.invoice.lines.map((line: any) => (
                      <tr key={line.id} className={line.proration ? 'proration' : ''}>
                        <td>
                          {line.description}
                          {line.proration && <span className="tag">proration</span>}
                          {preview.mode !== 'schedule' && (
                            <div className="period">
                              {day(line.periodStart)} → {day(line.periodEnd)}
                            </div>
                          )}
                        </td>
                        <td>{line.quantity ?? '—'}</td>
                        <td className="right">{money(line.amount, preview.invoice.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    {preview.mode !== 'schedule' && (
                      <>
                        <tr>
                          <td colSpan={2}>Prorations</td>
                          <td className="right">{money(preview.invoice.prorationTotal, preview.invoice.currency)}</td>
                        </tr>
                        <tr>
                          <td colSpan={2}>Applied account credit</td>
                          <td className="right">
                            {money(-(preview.invoice.startingBalance ?? 0), preview.invoice.currency)}
                          </td>
                        </tr>
                      </>
                    )}
                    <tr className="grand">
                      <td colSpan={2}>{preview.mode === 'schedule' ? 'Per period from then on' : 'Amount due'}</td>
                      <td className="right">{money(preview.invoice.amountDue, preview.invoice.currency)}</td>
                    </tr>
                  </tfoot>
                </table>
              )}

              <details className="raw">
                <summary>Exact Stripe parameters</summary>
                <pre>{JSON.stringify(preview.stripeParams, null, 2)}</pre>
              </details>
            </>
          )}
        </section>

        {(state.warnings ?? []).length > 0 && (
          <section className="card">
            <h2>Heads-up</h2>
            <ul className="hint list">
              {state.warnings.map((w: string, i: number) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
            {state.stripe?.hostedInvoiceUrl && state.stripe?.status === 'incomplete' && (
              <a className="ghost small" href={state.stripe.hostedInvoiceUrl} target="_blank" rel="noreferrer">
                Open hosted invoice to confirm payment
              </a>
            )}
          </section>
        )}

        <section className="card">
          <h2>{isLive ? 'Live subscription' : 'Stripe subscription'}</h2>
          {!state.stripe && <p className="hint">No Stripe subscription yet — the account is on the Free plan.</p>}
          {state.stripe && !isLive && (
            <p className="hint">
              This subscription is <strong>{state.stripe.status}</strong> and can no longer be changed. The account
              is back on the Free plan — picking a paid plan on the left starts a brand new subscription.
            </p>
          )}
          {state.stripe && (
            <>
              <dl className="facts">
                <div>
                  <dt>Subscription</dt>
                  <dd className="mono">{state.stripe.id}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{state.stripe.status}</dd>
                </div>
                <div>
                  <dt>Period</dt>
                  <dd>
                    {day(state.stripe.currentPeriodStart)} → {day(state.stripe.currentPeriodEnd)}
                  </dd>
                </div>
                <div>
                  <dt>Billing mode</dt>
                  <dd>{state.stripe.billingMode ?? '—'}</dd>
                </div>
                {state.stripe.trialEnd && (
                  <div>
                    <dt>Trial ends</dt>
                    <dd>{day(state.stripe.trialEnd)}</dd>
                  </div>
                )}
                {state.stripe.pauseCollection && (
                  <div>
                    <dt>Paused</dt>
                    <dd>{state.stripe.pauseCollection.behavior}</dd>
                  </div>
                )}
              </dl>

              {state.pendingChange && (
                <div className="banner ok inline">
                  <span>
                    Scheduled change ({state.pendingChange.ruleKey}): {state.pendingChange.changes?.join(', ')} —
                    effective {day(state.pendingChange.effectiveAt)}
                  </span>
                  {/*
                    Row 49 gives the customer a way back before the boundary.
                    Re-selecting the add-on cannot do it: the live subscription
                    still holds it, so the request reads as no change at all.
                  */}
                  <button
                    className="ghost small"
                    disabled={busy}
                    onClick={() =>
                      run(() => api.cancelScheduledChange(accountId), 'Scheduled change called off')
                    }
                  >
                    Call it off
                  </button>
                </div>
              )}

              {isLive && (
              <div className="row wrap top-gap">
                {state.account.cancelAtPeriodEnd ? (
                  <button className="ghost small" disabled={busy} onClick={() => run(() => api.resume(accountId), 'Cancellation reverted')}>
                    Undo cancellation
                  </button>
                ) : (
                  <button
                    className="ghost small danger"
                    disabled={busy}
                    onClick={() => run(() => api.cancel(accountId, {}), 'Cancellation processed per policy')}
                  >
                    Cancel (policy default)
                  </button>
                )}
                <button
                  className="ghost small danger"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () => api.cancel(accountId, { timing: 'immediate', prorateUnusedTime: true, invoiceImmediately: true }),
                      'Cancelled immediately with proration',
                    )
                  }
                >
                  Cancel now + prorate
                </button>
                {state.stripe.status === 'trialing' && (
                  <button
                    className="ghost small"
                    disabled={busy}
                    onClick={() => run(() => api.endTrial(accountId), 'Trial ended — Stripe billed the first period')}
                  >
                    End trial now
                  </button>
                )}
                {state.stripe.pauseCollection ? (
                  <button className="ghost small" disabled={busy} onClick={() => run(() => api.unpause(accountId), 'Collection resumed')}>
                    Resume collection
                  </button>
                ) : (
                  <button className="ghost small" disabled={busy} onClick={() => run(() => api.pause(accountId), 'Collection paused')}>
                    Pause (seasonal)
                  </button>
                )}
              </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
