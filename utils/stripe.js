import Stripe from 'stripe';

// Single Stripe instance — import this everywhere instead of calling new Stripe() again.
// The secret key is read once at startup; if it's missing the app will throw early.
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-04-10',
});

export default stripe;
