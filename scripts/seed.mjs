#!/usr/bin/env node
/**
 * Pushes the OptiSigns price book into Stripe (products + prices) and, if a
 * catalog already exists, refreshes it. Safe to re-run: prices are matched by
 * lookup_key so nothing is duplicated.
 */
const API = process.env.API_URL ?? 'http://localhost:3123/api';

const post = async (path, body) => {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
};

const get = async (path) => {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
};

const catalog = await get('/catalog');
if (!catalog.stripeConfigured) {
  console.error('STRIPE_SECRET_KEY is not set in backend/.env — nothing to sync.');
  process.exit(1);
}

console.log('Syncing catalog to Stripe…');
const result = await post('/catalog/sync-stripe');
console.log('  synced :', result.synced.join(', '));
console.log('  skipped:', result.skipped.join(', '), '(Free plan has no Stripe objects)');

const after = await get('/catalog');
for (const item of [...after.plans, ...after.addons]) {
  if (!item.monthlyPrice?.priceId) continue;
  console.log(
    `  ${item.code.padEnd(14)} monthly=${item.monthlyPrice.priceId} yearly=${item.yearlyPrice?.priceId}`,
  );
}
console.log('Done.');
