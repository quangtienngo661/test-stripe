import { useEffect, useState } from 'react';
import { api } from '../api';

export default function PolicyPanel({ run, busy, refreshToken }: any) {
  const [policy, setPolicy] = useState<any>(null);
  const [fields, setFields] = useState<any>(null);
  const [presets, setPresets] = useState<any[]>([]);
  const [metered, setMetered] = useState<any[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const loadMetered = () =>
    api
      .catalog()
      .then((c: any) => {
        const items = (c.addons ?? []).filter((a: any) => a.usagePriced);
        setMetered(items);
        setDrafts(Object.fromEntries(items.map((i: any) => [i.code, String(i.quotaAllowance ?? '')])));
      })
      .catch(() => setMetered([]));

  useEffect(() => {
    api.policy().then(setPolicy).catch(() => setPolicy(null));
    api.policyFields().then(setFields).catch(() => setFields(null));
    api.policyPresets().then(setPresets).catch(() => setPresets([]));
    loadMetered();
  }, [refreshToken]);

  if (!policy || !fields) return <div className="empty">Loading policy…</div>;

  const patchRule = (ruleKey: string, field: string, value: any) =>
    run(() => api.updatePolicy({ rules: { [ruleKey]: { [field]: value } } }), `${ruleKey}.${field} = ${value}`).then(() =>
      api.policy().then(setPolicy),
    );

  const patchSection = (section: string, field: string, value: any) =>
    run(() => api.updatePolicy({ [section]: { [field]: value } }), `${section}.${field} = ${value}`).then(() =>
      api.policy().then(setPolicy),
    );

  const Select = ({ value, options, onChange }: any) => (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={busy}>
      {options.map((o: any) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );

  const Toggle = ({ value, onChange }: any) => (
    <label className="check">
      <input type="checkbox" checked={!!value} disabled={busy} onChange={(e) => onChange(e.target.checked)} />
      {value ? 'on' : 'off'}
    </label>
  );

  return (
    <div className="stack">
      {(policy.warnings ?? []).length > 0 && (
        <section className="card">
          <h2>Settings that cannot fire</h2>
          <p className="hint">
            These are not errors — the combination is simply unreachable, so the setting looks active but never
            changes anything.
          </p>
          <ul className="hint list">
            {policy.warnings.map((w: string, i: number) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2>Presets</h2>
        <p className="hint">
          Active policy: <strong>{policy.basedOnPreset}</strong>. Applying a preset overwrites every rule below.
        </p>
        <div className="row wrap">
          {presets.map((p) => (
            <button
              key={p.key}
              className={policy.basedOnPreset === p.key ? 'seg active' : 'ghost small'}
              disabled={busy}
              title={p.description}
              onClick={() => run(() => api.applyPreset(p.key), `Preset "${p.name}" applied`).then(() => api.policy().then(setPolicy))}
            >
              {p.name}
            </button>
          ))}
        </div>
        <ul className="hint list">
          {presets.map((p) => (
            <li key={p.key}>
              <strong>{p.name}</strong> — {p.description}
            </li>
          ))}
        </ul>
      </section>

      {metered.length > 0 && (
        <section className="card">
          <h2>Metered allowances</h2>
          <p className="hint">
            How much each usage-priced add-on grants per month. This is the divisor in the credit sum — raising it
            makes every unspent unit worth less, so it changes what customers are owed when they switch tier.
            Nothing here touches Stripe.
          </p>
          <div className="settings">
            {metered.map((item: any) => (
              <div key={item.code}>
                <label>
                  {item.name}
                  <span className="plan-note">
                    {item.quotaLabel} · currently {item.quotaAllowance?.toLocaleString()}
                  </span>
                </label>
                <div className="row">
                  <input
                    type="number"
                    min={1}
                    value={drafts[item.code] ?? ''}
                    onChange={(e) => setDrafts({ ...drafts, [item.code]: e.target.value })}
                  />
                  <button
                    className="ghost small"
                    disabled={busy || Number(drafts[item.code]) === item.quotaAllowance || !drafts[item.code]}
                    onClick={() =>
                      run(
                        () => api.updateCatalogItem(item.code, { quotaAllowance: Number(drafts[item.code]) }),
                        `${item.name}: ${item.quotaLabel} set to ${Number(drafts[item.code]).toLocaleString()}`,
                      ).then(loadMetered)
                    }
                  >
                    Save
                  </button>
                </div>
              </div>
            ))}
          </div>
          <button
            className="ghost small top-gap"
            disabled={busy}
            onClick={() => run(() => api.resetAllowances(), 'Allowances back to the built-in defaults').then(loadMetered)}
          >
            Reset to defaults
          </button>
        </section>
      )}

      <section className="card">
        <h2>Change rules</h2>
        <p className="hint">
          Each row is one kind of subscription change. The values map straight onto the Stripe parameters used when
          that change is applied.
        </p>
        <table className="table policy">
          <thead>
            <tr>
              <th>Change</th>
              <th>timing</th>
              <th>proration_behavior</th>
              <th>billing_cycle_anchor</th>
              <th>payment_behavior</th>
              <th>credit handling</th>
            </tr>
          </thead>
          <tbody>
            {fields.ruleKeys.map((key: string) => {
              const rule = policy.policy.rules[key];
              return (
                <tr key={key}>
                  <td>
                    <strong>{fields.ruleLabels[key]}</strong>
                    <div className="period mono">{key}</div>
                  </td>
                  <td>
                    <Select value={rule.timing} options={fields.options.timing} onChange={(v: any) => patchRule(key, 'timing', v)} />
                  </td>
                  <td>
                    <Select
                      value={rule.prorationBehavior}
                      options={fields.options.prorationBehavior}
                      onChange={(v: any) => patchRule(key, 'prorationBehavior', v)}
                    />
                  </td>
                  <td>
                    <Select
                      value={rule.billingCycleAnchor}
                      options={fields.options.billingCycleAnchor}
                      onChange={(v: any) => patchRule(key, 'billingCycleAnchor', v)}
                    />
                  </td>
                  <td>
                    <Select
                      value={rule.paymentBehavior}
                      options={fields.options.paymentBehavior}
                      onChange={(v: any) => patchRule(key, 'paymentBehavior', v)}
                    />
                  </td>
                  <td>
                    <Select
                      value={rule.creditHandling}
                      options={fields.options.creditHandling}
                      onChange={(v: any) => patchRule(key, 'creditHandling', v)}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <div className="grid-2">
        <section className="card">
          <h2>Cancellation</h2>
          <div className="settings">
            <div>
              <label>timing</label>
              <Select
                value={policy.policy.cancellation.timing}
                options={fields.options.cancellationTiming}
                onChange={(v: any) => patchSection('cancellation', 'timing', v)}
              />
            </div>
            <div>
              <label>prorate unused time (Stripe `prorate`)</label>
              <Toggle
                value={policy.policy.cancellation.prorateUnusedTime}
                onChange={(v: any) => patchSection('cancellation', 'prorateUnusedTime', v)}
              />
            </div>
            <div>
              <label>invoice immediately (`invoice_now`)</label>
              <Toggle
                value={policy.policy.cancellation.invoiceImmediately}
                onChange={(v: any) => patchSection('cancellation', 'invoiceImmediately', v)}
              />
            </div>
            <div>
              <label>unused time goes to</label>
              <Select
                value={policy.policy.cancellation.refundUnusedTime}
                options={fields.options.creditHandling}
                onChange={(v: any) => patchSection('cancellation', 'refundUnusedTime', v)}
              />
            </div>
            <div>
              <label>drop to Free plan afterwards</label>
              <Toggle
                value={policy.policy.cancellation.moveToFreePlan}
                onChange={(v: any) => patchSection('cancellation', 'moveToFreePlan', v)}
              />
            </div>
          </div>
        </section>

        <section className="card">
          <h2>Trial</h2>
          <div className="settings">
            <div>
              <label>when a new subscription gets a trial</label>
              <Select
                value={policy.policy.trial.appliesTo}
                options={fields.options.trialAppliesTo}
                onChange={(v: any) => patchSection('trial', 'appliesTo', v)}
              />
            </div>
            <div>
              <label>days</label>
              <input
                type="number"
                value={policy.policy.trial.days}
                onChange={(e) => patchSection('trial', 'days', Number(e.target.value))}
              />
            </div>
            <div>
              <label>require a card up front</label>
              <Toggle
                value={policy.policy.trial.requirePaymentMethod}
                onChange={(v: any) => patchSection('trial', 'requirePaymentMethod', v)}
              />
            </div>
            <div>
              <label>if no card at trial end</label>
              <Select
                value={policy.policy.trial.missingPaymentMethodBehavior}
                options={fields.options.trialEndBehavior}
                onChange={(v: any) => patchSection('trial', 'missingPaymentMethodBehavior', v)}
              />
            </div>
          </div>
        </section>

        <section className="card">
          <h2>Invoicing</h2>
          <div className="settings">
            <div>
              <label>collection_method</label>
              <Select
                value={policy.policy.invoicing.collectionMethod}
                options={fields.options.collectionMethod}
                onChange={(v: any) => patchSection('invoicing', 'collectionMethod', v)}
              />
            </div>
            <div>
              <label>days_until_due (send_invoice)</label>
              <input
                type="number"
                value={policy.policy.invoicing.daysUntilDue}
                onChange={(e) => patchSection('invoicing', 'daysUntilDue', Number(e.target.value))}
              />
            </div>
            <div>
              <label>billing_mode (new subscriptions)</label>
              <Select
                value={policy.policy.invoicing.billingMode}
                options={fields.options.billingMode}
                onChange={(v: any) => patchSection('invoicing', 'billingMode', v)}
              />
            </div>
            <div>
              <label>automatic tax</label>
              <Toggle
                value={policy.policy.invoicing.automaticTax}
                onChange={(v: any) => patchSection('invoicing', 'automaticTax', v)}
              />
            </div>
            <div>
              <label>payment_behavior on create</label>
              <Select
                value={policy.policy.invoicing.defaultPaymentBehavior}
                options={fields.options.paymentBehavior}
                onChange={(v: any) => patchSection('invoicing', 'defaultPaymentBehavior', v)}
              />
            </div>
            <div>
              <label>anchor renewals to the 1st</label>
              <Toggle
                value={policy.policy.invoicing.anchorToFirstOfMonth}
                onChange={(v: any) => patchSection('invoicing', 'anchorToFirstOfMonth', v)}
              />
            </div>
          </div>
        </section>

        <section className="card">
          <h2>Refunds</h2>
          <div className="settings">
            <div>
              <label>window (days)</label>
              <input
                type="number"
                value={policy.policy.refunds.windowDays}
                onChange={(e) => patchSection('refunds', 'windowDays', Number(e.target.value))}
              />
            </div>
            <div>
              <label>mode</label>
              <Select
                value={policy.policy.refunds.mode}
                options={fields.options.refundMode}
                onChange={(v: any) => patchSection('refunds', 'mode', v)}
              />
            </div>
            <div>
              <label>default reason</label>
              <Select
                value={policy.policy.refunds.defaultReason}
                options={fields.options.refundReason}
                onChange={(v: any) => patchSection('refunds', 'defaultReason', v)}
              />
            </div>
            <div>
              <label>allow partial refunds</label>
              <Toggle
                value={policy.policy.refunds.allowPartial}
                onChange={(v: any) => patchSection('refunds', 'allowPartial', v)}
              />
            </div>
            <div>
              <label>auto-approve ceiling (cents)</label>
              <input
                type="number"
                value={policy.policy.refunds.maxAutoApproveCents}
                onChange={(e) => patchSection('refunds', 'maxAutoApproveCents', Number(e.target.value))}
              />
            </div>
          </div>
        </section>

        <section className="card">
          <h2>Constraints</h2>
          <div className="settings">
            <div>
              <label>enforce plan minimums (Enterprise = 25)</label>
              <Toggle
                value={policy.policy.constraints.enforceMinQuantity}
                onChange={(v: any) => patchSection('constraints', 'enforceMinQuantity', v)}
              />
            </div>
            <div>
              <label>add-on quantity ≤ screens</label>
              <Toggle
                value={policy.policy.constraints.addOnCannotExceedScreens}
                onChange={(v: any) => patchSection('constraints', 'addOnCannotExceedScreens', v)}
              />
            </div>
            <div>
              <label>Free plan screen cap</label>
              <input
                type="number"
                value={policy.policy.constraints.freePlanScreenCap}
                onChange={(e) => patchSection('constraints', 'freePlanScreenCap', Number(e.target.value))}
              />
            </div>
            <div>
              <label>allow reducing to 0 screens</label>
              <Toggle
                value={policy.policy.constraints.allowZeroScreens}
                onChange={(v: any) => patchSection('constraints', 'allowZeroScreens', v)}
              />
            </div>
            {/*
              The provider budget is the only thing that can refuse a quantity
              increase now that the per-plan ceiling is gone, so its dials belong
              where every other rule is turned.
            */}
            <div>
              <label>enforce provider capacity guard</label>
              <Toggle
                value={policy.policy.constraints.enforceCapacityGuard}
                onChange={(v: any) => patchSection('constraints', 'enforceCapacityGuard', v)}
              />
            </div>
            <div>
              <label>refuse above (post updates / month)</label>
              <input
                type="number"
                value={policy.policy.constraints.capacityBlockAtUnits}
                onChange={(e) => patchSection('constraints', 'capacityBlockAtUnits', Number(e.target.value))}
              />
            </div>
            <div>
              <label>warn above (post updates / month)</label>
              <input
                type="number"
                value={policy.policy.constraints.capacityWarnAtUnits}
                onChange={(e) => patchSection('constraints', 'capacityWarnAtUnits', Number(e.target.value))}
              />
            </div>
            <div>
              <label>each running trial commits</label>
              <input
                type="number"
                value={policy.policy.constraints.trialCapacityUnits}
                onChange={(e) => patchSection('constraints', 'trialCapacityUnits', Number(e.target.value))}
              />
            </div>
          </div>
        </section>

        <section className="card">
          <h2>Dunning & pause</h2>
          <div className="settings">
            <div>
              <label>on invoice.payment_failed</label>
              <Select
                value={policy.policy.dunning.pastDueBehavior}
                options={fields.options.pastDueBehavior}
                onChange={(v: any) => patchSection('dunning', 'pastDueBehavior', v)}
              />
            </div>
            <div>
              <label>pause_collection.behavior</label>
              <Select
                value={policy.policy.dunning.pauseBehavior}
                options={fields.options.pauseBehavior}
                onChange={(v: any) => patchSection('dunning', 'pauseBehavior', v)}
              />
            </div>
          </div>
        </section>
      </div>

      <details className="card raw">
        <summary>Raw policy JSON</summary>
        <pre>{JSON.stringify(policy.policy, null, 2)}</pre>
      </details>
    </div>
  );
}
