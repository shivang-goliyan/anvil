import { PrismaClient } from '../generated/prisma/client.ts';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { dbUrl } from './db-url.mjs';

// The API and the worker are separate processes writing the same file. WAL lets readers
// carry on while one of them writes; better-sqlite3 already waits 5s on a locked database.
export const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: dbUrl }) });
await db.$queryRawUnsafe('PRAGMA journal_mode = WAL');
