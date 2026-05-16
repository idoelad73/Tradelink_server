import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Create a Stripe Connect account for a trade
export async function createConnectAccount(email) {
  // functional code added later
}

// Create a payment intent
export async function createPaymentIntent(amount, currency = 'usd') {
  // functional code added later
}

export default stripe;
