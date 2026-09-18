import { useEffect, useState } from 'react';
import { api, day, money } from '../api';

export default function AccountPanel({ accounts, activeId, setActiveId, state, run, busy }: any) {
  const [form, setForm] = useState({ name: '', email: '', company: '', withTestClock: true });
  const [cards, setCards] = useState<any[]>([]);
  const [balance, setBalance] = useState<any>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.testCards().then(setCards).catch(() => setCards([]));
  }, []);

  useEffect(() => {
    if (!activeId) return setBalance(null);
    api.balance(activeId).then(setBalance).catch(() => setBalance(null));
  }, [activeId, state]);

  const account = state?.account;

  return (
    <section className="card">
      <h2>Demo account</h2>

      <select value={activeId ?? ''} onChange={(e) => setActiveId(e.target.value || null)}>
        <option value="">— select an account —</option>
        {accounts.map((a: any) => (
          <option key={a._id} value={a._id}>
            {a.name} · {a.planCode} · {a.screens} screens
          </option>
        ))}
      </select>

      {!creating && (
        <button className="ghost full" onClick={() => setCreating(true)}>
          + New demo account
        </button>
      )}

      {creating && (
        <div className="stack">
          <input
            placeholder="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            placeholder="Email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          <input
            placeholder="Company (optional)"
            value={form.company}
            onChange={(e) => setForm({ ...form, company: e.target.value })}
          />
          <label className="check">
            <input
              type="checkbox"
              checked={form.withTestClock}
              onChange={(e) => setForm({ ...form, withTestClock: e.target.checked })}
            />
            Attach a Stripe test clock (lets you fast-forward to renewals)
          </label>
          <div className="row">
            <button
              disabled={busy || !form.email || !form.name}
              onClick={async () => {
                const created = await run(() => api.createAccount(form), 'Account + Stripe customer created');
                if (created?._id) {
                  setActiveId(created._id);
                  setCreating(false);
                  setForm({ name: '', email: '', company: '', withTestClock: true });
                }
              }}
            >
              Create
            </button>
            <button className="ghost" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {account && (
        <>
          <dl className="facts">
            <div>
              <dt>Stripe customer</dt>
              <dd className="mono">{account.stripeCustomerId}</dd>
            </div>
            <div>
              <dt>Plan</dt>
              <dd>
                {account.planCode} · {account.screens} screens · {account.term}
              </dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                {account.subscriptionStatus}
                {account.cancelAtPeriodEnd ? ' (cancels at period end)' : ''}
                {account.deactivated ? ' · deactivated (0 screens)' : ''}
              </dd>
            </div>
            <div>
              <dt>Renews</dt>
              <dd>{day(state?.stripe?.currentPeriodEnd)}</dd>
            </div>
            <div>
              <dt>Account credit</dt>
              <dd className={balance?.balance < 0 ? 'credit' : ''}>
                {balance ? money(Math.abs(balance.balance), balance.currency) : '—'}
                {balance?.balance < 0 ? ' credit' : balance?.balance > 0 ? ' owed' : ''}
              </dd>
            </div>
          </dl>

          <h3>Payment method</h3>
          <p className="hint">{account.paymentMethodLabel ?? 'No card on file — the subscription will start on trial.'}</p>
          <div className="row wrap">
            {cards.map((card) => (
              <button
                key={card.key}
                className="ghost small"
                disabled={busy}
                title={card.label}
                onClick={() => run(() => api.attachTestCard(activeId, card.key), `Attached ${card.label}`)}
              >
                {card.key}
              </button>
            ))}
          </div>

          <div className="row wrap top-gap">
            <button
              className="ghost small"
              disabled={busy}
              onClick={async () => {
                const session = await run(() => api.portalSession(activeId));
                if (session?.url) window.open(session.url, '_blank');
              }}
            >
              Open Stripe portal
            </button>
            <button
              className="ghost small"
              disabled={busy}
              onClick={() => run(() => api.syncPortalConfig(), 'Portal configuration now mirrors the policy')}
            >
              Sync portal config
            </button>
            <button
              className="ghost small danger"
              disabled={busy}
              onClick={() => {
                if (confirm('Delete this demo account and its Stripe customer?')) {
                  run(() => api.deleteAccount(activeId), 'Account deleted').then(() => setActiveId(null));
                }
              }}
            >
              Delete account
            </button>
          </div>
        </>
      )}
    </section>
  );
}
