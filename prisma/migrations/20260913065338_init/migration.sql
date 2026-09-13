-- CreateTable
CREATE TABLE "Capability" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "inputSchema" JSONB NOT NULL,
    "canary" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'healthy',
    "planId" TEXT,
    "contractId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Capability_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Capability_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "capabilityId" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "derivedFrom" TEXT,
    "version" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "origin" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Plan_capabilityId_fkey" FOREIGN KEY ("capabilityId") REFERENCES "Capability" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Contract" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "capabilityId" TEXT NOT NULL,
    "goldenSample" JSONB NOT NULL,
    "requiredFields" JSONB NOT NULL,
    "fieldTypes" JSONB NOT NULL,
    "minRecords" INTEGER NOT NULL,
    "bounds" JSONB NOT NULL,
    "echoes" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Contract_capabilityId_fkey" FOREIGN KEY ("capabilityId") REFERENCES "Capability" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Run" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "capabilityId" TEXT NOT NULL,
    "planId" TEXT,
    "inputs" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "result" JSONB,
    "failureKind" TEXT,
    "startedAt" DATETIME,
    "endedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Run_capabilityId_fkey" FOREIGN KEY ("capabilityId") REFERENCES "Capability" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Run_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RepairAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "capabilityId" TEXT NOT NULL,
    "fromPlanId" TEXT,
    "toPlanId" TEXT,
    "trigger" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'queued',
    "diagnosis" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RepairAttempt_capabilityId_fkey" FOREIGN KEY ("capabilityId") REFERENCES "Capability" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TraceEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runId" TEXT,
    "repairId" TEXT,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TraceEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TraceEvent_repairId_fkey" FOREIGN KEY ("repairId") REFERENCES "RepairAttempt" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "payload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "tries" INTEGER NOT NULL DEFAULT 0,
    "runAfter" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" DATETIME,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PageSnapshot" (
    "hash" TEXT NOT NULL PRIMARY KEY,
    "url" TEXT NOT NULL,
    "shape" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "CreditSpend" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "kind" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "Capability_planId_key" ON "Capability"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "Capability_contractId_key" ON "Capability"("contractId");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_capabilityId_version_key" ON "Plan"("capabilityId", "version");

-- CreateIndex
CREATE INDEX "Run_capabilityId_status_idx" ON "Run"("capabilityId", "status");

-- CreateIndex
CREATE INDEX "RepairAttempt_capabilityId_outcome_idx" ON "RepairAttempt"("capabilityId", "outcome");

-- CreateIndex
CREATE UNIQUE INDEX "TraceEvent_runId_seq_key" ON "TraceEvent"("runId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "TraceEvent_repairId_seq_key" ON "TraceEvent"("repairId", "seq");

-- CreateIndex
CREATE INDEX "Job_status_runAfter_idx" ON "Job"("status", "runAfter");

-- CreateIndex
CREATE INDEX "CreditSpend_createdAt_idx" ON "CreditSpend"("createdAt");
