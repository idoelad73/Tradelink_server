# TradeLink — Server

Node.js ESM + Express v5 + MongoDB/Mongoose. Entry: `server.js` → `app.js`.

## Stack
- **Auth**: JWT (jsonwebtoken) + bcrypt — `middleware/auth.js` (`protect`, `restrictTo`)
- **Uploads**: Multer memory storage → Cloudinary (`utils/cloudinary.js`)
- **Email**: Nodemailer Gmail SMTP — `utils/mailer.js`
- **Payments**: Stripe Connect — `utils/stripe.js`
- **Validation**: Zod (controllers)
- **Error handling**: throw `AppError(message, statusCode)` → caught by `middleware/errorHandler.js`

## Routes
All mounted under `/api` in `routes/index.js`:
`auth` · `trade` · `contractor` · `chat`

## Models
`User` · `TradePro` · `Contractor` · `Site` · `Chat` · `Message` · `Application`

## Dev
```bash
npm run dev    # node --watch server.js
npm test       # vitest + supertest against in-memory mongo — see tests/README.md
```

## Env
See `.env.example`.
