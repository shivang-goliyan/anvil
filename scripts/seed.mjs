// Puts the demo capabilities in the database.  --reset wipes their runs, repairs and learned plans.

import { db } from '../src/db.mjs';
import { seedCapability } from '../src/capabilities.mjs';
import { reserveRoom } from '../capabilities/reserve-room.mjs';
import { harborEvents } from '../capabilities/harbor-events.mjs';

const reset = process.argv.includes('--reset');
for (const def of [reserveRoom(), harborEvents()]) {
  const { created, learned, learning } = await seedCapability(def, { reset });
  const how = learned ? 'the plan learned from its sentence' : learning ? 'a learning job (no saved learned plan yet)' : 'its first plan';
  console.log(`${def.id}: ${created ? `${reset ? 'reset' : 'created'} with ${how}` : 'already there, left alone (use --reset)'}  target ${def.targetUrl}`);
}
await db.$disconnect();
