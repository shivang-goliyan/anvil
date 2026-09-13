import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Kept apart from db.mjs so the prisma CLI can read it without loading the client.
const fallback = fileURLToPath(new URL('../state/anvil.db', import.meta.url));
if (!process.env.DATABASE_URL) mkdirSync(fileURLToPath(new URL('../state/', import.meta.url)), { recursive: true });

export const dbUrl = process.env.DATABASE_URL || `file:${fallback}`;
