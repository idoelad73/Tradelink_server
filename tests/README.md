# Server tests

Vitest + Supertest against an in-memory MongoDB. Nothing here touches the
network, a real database, Stripe, or Resend.

```bash
npm test           # everything, once
npm run test:watch # re-run on change
npm run test:unit  # tests/unit only
npm run test:api   # tests/api only
```

## Layout

| Path | What it holds |
|---|---|
| `setup.js` | Env vars, module mocks, in-memory Mongo lifecycle. Runs before every file. |
| `mocks/stripe.js` | Controllable fake of `utils/stripe.js` with happy-path defaults. |
| `helpers/factories.js` | Document builders + JWT helpers (`asContractor`, `asTrade`). |
| `unit/` | Pure logic — no HTTP. |
| `api/` | Real Express routes driven through Supertest. |

## How it works

`app.js` never connects to MongoDB (only `server.js` does), so tests import the
app directly and point Mongoose at a `mongodb-memory-server` instance instead.

`setup.js` sets `JWT_SECRET`, `STRIPE_SECRET_KEY` and friends **before** any
application module is imported — the controllers read `process.env` at import
time, and nothing in the test path loads dotenv. This is deliberate: it makes it
impossible for a test run to pick up the developer's real `.env`, in particular a
live Stripe key.

Between tests, documents are deleted but collections are not dropped. Dropping
would also drop the indexes Mongoose built on connect, and `Message` relies on a
partial unique index that would silently stop being enforced.

## Writing a test

Override only the Stripe call your test is about; the rest stay on their
happy-path defaults:

```js
stripeMock.accounts.retrieve.mockResolvedValueOnce({
  payouts_enabled:   false,
  external_accounts: { data: [] },
});
```

Authenticate with the factory helpers rather than logging in over HTTP:

```js
const contractor = await createContractor();
await request(app).get('/api/contractor/me').set(asContractor(contractor));
```

## Gotcha: `verifyPayoutReady` is mode-dependent

`utils/payoutReadiness.js` reads `STRIPE_SECRET_KEY` **once at module load** to
decide whether an unverifiable bank account blocks a payout. Under an `sk_test_*`
key it does not; under `sk_live_*` it does. Because the flag is captured at
import time, `unit/payoutReadiness.test.js` uses `vi.resetModules()` plus a
dynamic import to exercise both modes. If you change that module, keep both
`describe` blocks — the harness's own key is `sk_test_fake`, so the live-mode
branch is otherwise never covered.
