import { Fragment, useEffect, useState } from 'react';
import { api, day, money, when } from '../api';

export default function InvoicesPanel({ accountId, run, busy, refreshToken }: any) {
  const [invoices, setInvoices] = useState<any[]>([]);
  const [creditNotes, setCreditNotes] = useState<any[]>([]);
  const [refunds, setRefunds] = useState<any[]>([]);
  const [renewal, setRenewal] = useState<any>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [refundForm, setRefundForm] = useState<any>({});

  useEffect(() => {
    if (!accountId) return;
    api.invoices(accountId).then(setInvoices).catch(() => setInvoices([]));
    api.creditNotes(accountId).then(setCreditNotes).catch(() => setCreditNotes([]));
    api.refunds(accountId).then(setRefunds).catch(() => setRefunds([]));
    api.renewalPreview(accountId).then(setRenewal).catch(() => setRenewal(null));
  }, [accountId, refreshToken]);

  return (
    <div className="stack">
      {renewal && (
        <section className="card">
          <h2>Next renewal (preview)</h2>
          <p className="hint">
            {day(renewal.periodStart)} → {day(renewal.periodEnd)} · includes every proration created so far
          </p>
          <table className="lines">
            <tbody>
              {renewal.lines.map((line: any) => (
                <tr key={line.id} className={line.proration ? 'proration' : ''}>
                  <td>
                    {line.description}
                    {line.proration && <span className="tag">proration</span>}
                  </td>
                  <td>{line.quantity ?? '—'}</td>
                  <td className="right">{money(line.amount, renewal.currency)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="grand">
                <td colSpan={2}>Amount due</td>
                <td className="right">{money(renewal.amountDue, renewal.currency)}</td>
              </tr>
            </tfoot>
          </table>
        </section>
      )}

      <section className="card">
        <h2>Invoices</h2>
        {invoices.length === 0 && <p className="hint">No invoices yet.</p>}
        <table className="table">
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Reason</th>
              <th>Status</th>
              <th className="right">Total</th>
              <th className="right">Paid</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => (
              <Fragment key={inv.id}>
                <tr>
                  <td>
                    <button className="link" onClick={() => setExpanded(expanded === inv.id ? null : inv.id)}>
                      {inv.number ?? inv.id}
                    </button>
                    <div className="period">{when(inv.created)}</div>
                  </td>
                  <td>{inv.billingReason}</td>
                  <td>
                    <span className={`pill ${inv.status === 'paid' ? 'ok' : inv.status === 'open' ? 'warn' : ''}`}>
                      {inv.status}
                    </span>
                  </td>
                  <td className="right">{money(inv.total, inv.currency)}</td>
                  <td className="right">{money(inv.amountPaid, inv.currency)}</td>
                  <td className="right nowrap">
                    {inv.status === 'open' && (
                      <button className="ghost small" disabled={busy} onClick={() => run(() => api.payInvoice(inv.id), 'Collection retried')}>
                        Pay
                      </button>
                    )}
                    {inv.status === 'open' && (
                      <button className="ghost small" disabled={busy} onClick={() => run(() => api.voidInvoice(inv.id), 'Invoice voided')}>
                        Void
                      </button>
                    )}
                    {inv.status === 'paid' && inv.amountPaid > 0 && (
                      <button
                        className="ghost small"
                        onClick={() => setRefundForm({ invoiceId: inv.id, amount: (inv.amountPaid / 100).toFixed(2), currency: inv.currency })}
                      >
                        Refund
                      </button>
                    )}
                    {inv.hostedInvoiceUrl && (
                      <a className="ghost small" href={inv.hostedInvoiceUrl} target="_blank" rel="noreferrer">
                        Open
                      </a>
                    )}
                  </td>
                </tr>
                {expanded === inv.id && (
                  <tr>
                    <td colSpan={6}>
                      <table className="lines nested">
                        <tbody>
                          {inv.lines.map((line: any) => (
                            <tr key={line.id} className={line.proration ? 'proration' : ''}>
                              <td>
                                {line.description}
                                {line.proration && <span className="tag">proration</span>}
                                <div className="period">
                                  {day(line.periodStart)} → {day(line.periodEnd)}
                                </div>
                              </td>
                              <td>{line.quantity ?? '—'}</td>
                              <td className="right">{money(line.amount, inv.currency)}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr>
                            <td colSpan={2}>Starting balance applied</td>
                            <td className="right">{money(inv.startingBalance, inv.currency)}</td>
                          </tr>
                          <tr className="grand">
                            <td colSpan={2}>Amount due</td>
                            <td className="right">{money(inv.amountDue, inv.currency)}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </section>

      {refundForm.invoiceId && (
        <section className="card">
          <h2>Refund invoice</h2>
          <p className="hint mono">{refundForm.invoiceId}</p>
          <div className="row wrap">
            <label className="mini">Amount</label>
            <input
              type="number"
              step="0.01"
              value={refundForm.amount}
              onChange={(e) => setRefundForm({ ...refundForm, amount: e.target.value })}
            />
            <label className="mini">Mode</label>
            <select value={refundForm.mode ?? ''} onChange={(e) => setRefundForm({ ...refundForm, mode: e.target.value })}>
              <option value="">(policy default)</option>
              <option value="credit_note">credit_note</option>
              <option value="refund">refund</option>
            </select>
            <label className="mini">Reason</label>
            <select value={refundForm.reason ?? ''} onChange={(e) => setRefundForm({ ...refundForm, reason: e.target.value })}>
              <option value="">(policy default)</option>
              <option value="order_change">order_change</option>
              <option value="duplicate">duplicate</option>
              <option value="product_unsatisfactory">product_unsatisfactory</option>
              <option value="fraudulent">fraudulent</option>
            </select>
            <label className="check">
              <input
                type="checkbox"
                checked={!!refundForm.force}
                onChange={(e) => setRefundForm({ ...refundForm, force: e.target.checked })}
              />
              force (bypass window / ceiling)
            </label>
          </div>
          <div className="row top-gap">
            <button
              disabled={busy}
              onClick={() =>
                run(
                  () =>
                    api.refund(accountId, {
                      invoiceId: refundForm.invoiceId,
                      amountCents: Math.round(Number(refundForm.amount) * 100),
                      mode: refundForm.mode || undefined,
                      reason: refundForm.reason || undefined,
                      force: refundForm.force,
                    }),
                  'Refund processed',
                ).then(() => setRefundForm({}))
              }
            >
              Issue refund
            </button>
            <button className="ghost" onClick={() => setRefundForm({})}>
              Cancel
            </button>
          </div>
        </section>
      )}

      <section className="card">
        <h2>Credit notes</h2>
        {creditNotes.length === 0 && <p className="hint">None yet.</p>}
        {creditNotes.map((n) => (
          <div className="listrow" key={n.id}>
            <div>
              <strong>{n.number}</strong>
              <span className="plan-note">
                {n.reason} · {when(n.created)} · invoice {String(n.invoice)}
              </span>
            </div>
            <span>{money(n.total, n.currency)}</span>
          </div>
        ))}
      </section>

      <section className="card">
        <h2>Refunds</h2>
        {refunds.length === 0 && <p className="hint">None yet.</p>}
        {refunds.map((r) => (
          <div className="listrow" key={r.id}>
            <div>
              <strong className="mono">{r.id}</strong>
              <span className="plan-note">
                {r.status} · {when(r.created)} · {r.metadata?.reason ?? r.reason ?? ''}
              </span>
            </div>
            <span>{money(r.amount, r.currency)}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
