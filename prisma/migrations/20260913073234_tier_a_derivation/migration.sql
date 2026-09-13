-- CreateTable
CREATE TABLE "Derivation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "capabilityId" TEXT NOT NULL,
    "entryUrl" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'queued',
    "via" TEXT,
    "operativeUrl" TEXT,
    "screenshot" TEXT,
    "diagnosis" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Derivation_capabilityId_fkey" FOREIGN KEY ("capabilityId") REFERENCES "Capability" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Capability" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "entryUrl" TEXT,
    "targetUrl" TEXT NOT NULL,
    "inputSchema" JSONB NOT NULL,
    "canary" TEXT NOT NULL,
    "engine" TEXT NOT NULL DEFAULT 'browser',
    "status" TEXT NOT NULL DEFAULT 'healthy',
    "planId" TEXT,
    "contractId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Capability_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Capability_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Capability" ("canary", "contractId", "createdAt", "goal", "id", "inputSchema", "name", "planId", "status", "targetUrl") SELECT "canary", "contractId", "createdAt", "goal", "id", "inputSchema", "name", "planId", "status", "targetUrl" FROM "Capability";
DROP TABLE "Capability";
ALTER TABLE "new_Capability" RENAME TO "Capability";
CREATE UNIQUE INDEX "Capability_planId_key" ON "Capability"("planId");
CREATE UNIQUE INDEX "Capability_contractId_key" ON "Capability"("contractId");
CREATE TABLE "new_TraceEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runId" TEXT,
    "repairId" TEXT,
    "derivationId" TEXT,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TraceEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TraceEvent_repairId_fkey" FOREIGN KEY ("repairId") REFERENCES "RepairAttempt" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TraceEvent_derivationId_fkey" FOREIGN KEY ("derivationId") REFERENCES "Derivation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_TraceEvent" ("createdAt", "detail", "id", "kind", "label", "repairId", "runId", "seq") SELECT "createdAt", "detail", "id", "kind", "label", "repairId", "runId", "seq" FROM "TraceEvent";
DROP TABLE "TraceEvent";
ALTER TABLE "new_TraceEvent" RENAME TO "TraceEvent";
CREATE UNIQUE INDEX "TraceEvent_runId_seq_key" ON "TraceEvent"("runId", "seq");
CREATE UNIQUE INDEX "TraceEvent_repairId_seq_key" ON "TraceEvent"("repairId", "seq");
CREATE UNIQUE INDEX "TraceEvent_derivationId_seq_key" ON "TraceEvent"("derivationId", "seq");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
