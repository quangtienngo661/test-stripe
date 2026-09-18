import { useEffect, useState } from 'react';
import { api, day } from '../api';

/**
 * A knob for consumption, in the same spirit as the time machine: production
 * gets this number from whatever meters real usage, so the demo supplies it by
 * hand. Every price the billing engine works out for a usage-priced add-on
 * reads from here.
 */
export default function UsageMeter({ accountId, state, run, busy }: any) {
  const [catalog, setCatalog] = useState<any>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    api.catalog().then(setCatalog).catch(() => setCatalog(null));
  }, []);

  // the box shows the stored number so it reads as something you edit, not as a
  // blank to fill in; it follows the meter whenever that changes underneath
  const stored = JSON.stringify(state?.account?.usage ?? {});
  useEffect(() => {
    const usage = state?.account?.usage ?? {};
    setDraft(Object.fromEntries(Object.keys(usage).map((f) => [f, String(usage[f] ?? 0)])));
  }, [stored]);

  if (!catalog || !state?.account) return null;

  const metered = (catalog.addons ?? []).filter((a: any) => a.usagePriced);
  if (metered.length === 0) return null;

  // which tier, if any, the account is holding right now
  const families = [...new Set(metered.map((a: any) => a.family))] as string[];
  const rows = families
    .map((family) => {
      const tiers = metered.filter((a: any) => a.family === family);
      const held = (state.current?.addOns ?? []).find((a: any) =>
        tiers.some((t: any) => t.code === a.code),
      );
      const tier = held ? tiers.find((t: any) => t.code === held.code) : null;
      return { family, tier, tiers, cycle: state.usageCycle?.[family] ?? null };
    })
    .filter((r) => r.tier);

  if (rows.length === 0) {
    return (
      <section className="card">
        <h2>Usage meter</h2>
        <p className="hint">
          No usage-priced add-on on this account yet. Add X Social on the Subscription tab and the meter appears
          here.
        </p>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Usage meter</h2>
      <p className="hint">
        Stands in for whatever counts real usage. Every credit on a usage-priced add-on is worked out from this
        number, not from the calendar.
      </p>
      {rows.map(({ family, tier, cycle }: any) => {
        // the backend already rolled this to 0 if it belonged to a month that has passed
        const used = cycle?.used ?? state.account.usage?.[family] ?? 0;
        const allowance = tier.quotaAllowance ?? 0;
        const pct = allowance ? Math.min(100, Math.round((used / allowance) * 100)) : 0;
        const unitValue = state.current.term === 'yearly' ? tier.annualMonthlyCents : tier.monthlyCents;
        const worth = allowance ? Math.round((unitValue * (allowance - used)) / allowance) : 0;
        return (
          <div key={family}>
            <p className="clock">
              {used.toLocaleString()} / {allowance.toLocaleString()}
            </p>
            <div className="meter">
              <div className="meter-fill" style={{ width: `${pct}%` }} />
            </div>
            <p className="hint">
              {tier.quotaLabel} on {tier.name} · {(allowance - used).toLocaleString()} left, worth{' '}
              <strong>${(worth / 100).toFixed(2)}</strong> if given up now
            </p>
            {cycle && (
              <p className="hint">
                {cycle.monthsInPeriod > 1
                  ? `Allowance month ${cycle.index + 1} of ${cycle.monthsInPeriod} · resets ${day(cycle.cycleEnd)}`
                  : `Resets ${day(cycle.cycleEnd)}`}
                {cycle.monthsAhead > 0 && ` · ${cycle.monthsAhead} untouched month(s) ahead`}
              </p>
            )}
            <div className="row wrap">
              {[10, 100, 500].map((step) => (
                <button
                  key={step}
                  className="ghost small"
                  disabled={busy}
                  onClick={() => run(() => api.consumeUsage(accountId, family, step), `Spent ${step} more`)}
                >
                  +{step}
                </button>
              ))}
              <button
                className="ghost small"
                disabled={busy || used === 0}
                onClick={() => run(() => api.setUsage(accountId, family, 0), 'Meter back to zero')}
              >
                Reset
              </button>
            </div>
            <div className="field top-gap">
              <label>Type a number instead</label>
              <div className="row">
                <input
                  type="number"
                  min={0}
                  max={allowance}
                  value={draft[family] ?? String(used)}
                  onChange={(e) => setDraft({ ...draft, [family]: e.target.value })}
                />
                <span className="plan-note">of {allowance.toLocaleString()}</span>
                <button
                  className="ghost small"
                  disabled={busy || draft[family] === '' || Number(draft[family] ?? used) === used}
                  onClick={() =>
                    run(
                      () => api.setUsage(accountId, family, Number(draft[family])),
                      `${tier.quotaLabel}: meter set to ${Number(draft[family]).toLocaleString()}`,
                    )
                  }
                >
                  Set
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </section>
  );
}
