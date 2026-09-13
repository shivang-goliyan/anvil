import { defineConfig } from 'prisma/config';
import { dbUrl } from './src/db-url.mjs';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: dbUrl },
});
