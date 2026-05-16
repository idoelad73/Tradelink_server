# TradeLink — Server

Node.js + Express + MongoDB REST API.

## Stack
- **Runtime**: Node.js (ESM, `"type": "module"`)
- **Framework**: Express v5
- **Database**: MongoDB + Mongoose
- **Auth**: JWT (jsonwebtoken) + bcrypt
- **File uploads**: Multer (memory storage) → Cloudinary
- **Email**: Nodemailer — Gmail SMTP/OAuth2 (MVP), Resend prep (post-MVP)
  - Supported providers: Gmail, Yahoo, iCloud, AOL, Zoho
- **Payments**: Stripe Connect
- **Validation**: Zod

## Folder structure
```
server/
├── app.js                  # Express app (middleware + routes wired)
├── server.js               # Entry point — connectDB → listen
├── config/
│   └── db.js               # Mongoose connection
├── controllers/            # One file per domain (authController, jobController …)
├── models/                 # Mongoose schemas (User, Job, Trade …)
├── routes/
│   └── index.js            # Mounts all sub-routers under /api
├── middleware/
│   ├── auth.js             # protect, restrictTo
│   ├── upload.js           # Multer memory-storage instance
│   └── errorHandler.js     # Central error handler (4-param)
└── utils/
    ├── cloudinary.js       # uploadToCloudinary, deleteFromCloudinary
    ├── mailer.js           # sendMail (provider-agnostic)
    └── stripe.js           # Stripe Connect helpers
```

## Conventions
- **Routes**: `/api/<resource>` — plural, lowercase
- **Query keys (TanStack)**: always `['entity', id]`
- **Error handling**: throw `AppError(message, statusCode)`, caught by `errorHandler`
- **Env vars**: never hard-code — always `process.env.X`

## Environment variables
See `.env.example` for the full list.

## Dev
```bash
npm run dev    # node --watch server.js
npm start      # node server.js
```
