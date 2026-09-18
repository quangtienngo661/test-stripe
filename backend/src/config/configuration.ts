export interface AppConfig {
  port: number;
  mongoUri: string;
  stripeSecretKey: string;
  stripePublishableKey: string;
  stripeWebhookSecret: string;
  frontendUrl: string;
  currency: string;
}

export const configuration = (): AppConfig => ({
  port: Number(process.env.PORT ?? 3123),
  mongoUri: process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27099/optisigns_billing_demo',
  stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? '',
  stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:5555',
  currency: (process.env.CURRENCY ?? 'usd').toLowerCase(),
});
