-- Tamper-evident audit trail: hash-chain columns on each incident event.
ALTER TABLE "IncidentEvent" ADD COLUMN "prevHash" TEXT;
ALTER TABLE "IncidentEvent" ADD COLUMN "hash" TEXT;
