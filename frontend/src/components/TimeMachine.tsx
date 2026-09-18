import { useEffect, useState } from 'react';
import { api, when } from '../api';

const PRESETS = [
  { key: 'one_day', label: '+1 day' },
  { key: 'one_week', label: '+1 week' },
  { key: 'one_month', label: '+1 month' },
  { key: 'end_of_trial', label: 'End of trial' },
  { key: 'next_renewal', label: 'Next renewal' },
];

export default function TimeMachine({ accountId, run, busy, refreshToken }: any) {
  const [clock, setClock] = useState<any>(null);

  useEffect(() => {
    if (!accountId) return;
    api.clock(accountId).then(setClock).catch(() => setClock(null));
  }, [accountId, refreshToken]);

  if (!clock?.enabled) {
    return (
      <section className="card">
        <h2>Time machine</h2>
        <p className="hint">
          This account has no Stripe test clock. Create a new account with the test clock option to fast-forward
          through renewals, trial ends and dunning.
        </p>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Time machine</h2>
      <p className="hint">
        Stripe test clock <span className="mono">{clock.id}</span>
      </p>
      <p className="clock">{when(clock.frozenTime)}</p>
      <p className="hint">status: {clock.status}</p>
      <div className="row wrap">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            className="ghost small"
            disabled={busy}
            onClick={() =>
              run(() => api.advance(accountId, { preset: p.key }), `Clock advanced (${p.label}) — Stripe re-ran billing`)
            }
          >
            {p.label}
          </button>
        ))}
      </div>
      <p className="hint top-gap">
        Advancing runs Stripe's real billing engine: renewal invoices, proration sweeps, scheduled downgrades and
        failed-payment retries all happen for real.
      </p>
    </section>
  );
}
