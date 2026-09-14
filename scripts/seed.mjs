// Puts the demo capabilities in the database.  --reset wipes their runs, repairs and learned plans.

import { db } from '../src/db.mjs';
import { seedCapability } from '../src/capabilities.mjs';
import { reserveRoom } from '../capabilities/reserve-room.mjs';
import { harborEvents } from '../capabilities/harbor-events.mjs';

const reset = process.argv.includes('--reset');
for (const def of [reserveRoom(), harborEvents()]) {
  const { created } = await seedCapability(def, { reset });
  console.log(`${def.id}: ${created ? (reset ? 'reset to hand-written plan v1' : 'created') : 'already there, left alone (use --reset)'}  target ${def.targetUrl}`);
}
await db.$disconnect();
