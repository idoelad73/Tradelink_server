/**
 * removeContractorRead.js
 * One-time migration: removes the contractorRead field from all message documents.
 *
 * Run:
 *   node server/scripts/removeContractorRead.js
 */

import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../.env') });

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error('MONGO_URI not set in .env'); process.exit(1); }

await mongoose.connect(MONGO_URI);
console.log('Connected to MongoDB');

const result = await mongoose.connection.db
  .collection('messages')
  .updateMany({}, { $unset: { contractorRead: '' } });

console.log(`messages — removed contractorRead from ${result.modifiedCount} document(s)`);

await mongoose.disconnect();
console.log('Done.');
