import { useEffect, useState } from 'react';
import { api } from '../api';

export default function EventsPanel({ accountId, run, refreshToken }: any) {
  const [events, setEvents] = useState<any[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    api.events(accountId ?? undefined).then(setEvents).catch(() => setEvents([]));
  }, [accountId, refreshToken]);

  return (
    <section className="card">
      <div className="row between">
        <h2>Activity log</h2>
        <button className="ghost small" onClick={() => run(() => api.clearEvents(accountId ?? undefined), 'Log cleared')}>
          Clear
        </button>
      </div>
      <p className="hint">
        Every API call and webhook, with the policy that was in force and the exact payload sent to Stripe.
      </p>
      {events.length === 0 && <p className="hint">Nothing logged yet.</p>}
      {events.map((e) => (
        <div className="event" key={e._id}>
          <div className="event-head" onClick={() => setOpen(open === e._id ? null : e._id)}>
            <span className={`pill ${e.source === 'webhook' ? '' : 'ok'}`}>{e.source}</span>
            <strong>{e.action}</strong>
            {e.ruleKey && <span className="tag">{e.ruleKey}</span>}
            <span className="period">{new Date(e.createdAt).toLocaleString('en-GB')}</span>
          </div>
          <div className="event-summary">{e.summary}</div>
          {open === e._id && (
            <div className="event-body">
              {e.policyApplied && (
                <>
                  <h4>Policy applied</h4>
                  <pre>{JSON.stringify(e.policyApplied, null, 2)}</pre>
                </>
              )}
              {e.stripeRequest && (
                <>
                  <h4>Stripe request</h4>
                  <pre>{JSON.stringify(e.stripeRequest, null, 2)}</pre>
                </>
              )}
              {e.result && (
                <>
                  <h4>Result</h4>
                  <pre>{JSON.stringify(e.result, null, 2)}</pre>
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
