// The oldest queued job whose capability has nothing running.
export function pickJob(queued, busy) {
  return queued.find((j) => !busy.has(j.capabilityId)) ?? null;
}

// Two workers that claim jobs for one capability at the same moment: the newer job goes back in the queue.
export const yieldsTo = (mine, other) => other.createdAt < mine.createdAt || (+other.createdAt === +mine.createdAt && other.id < mine.id);
