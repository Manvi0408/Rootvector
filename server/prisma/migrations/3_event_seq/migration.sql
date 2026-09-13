-- Strict creation-order sequence for the audit hash chain (avoids same-ms ties).
ALTER TABLE "IncidentEvent" ADD COLUMN "seq" SERIAL NOT NULL;
CREATE UNIQUE INDEX "IncidentEvent_seq_key" ON "IncidentEvent"("seq");
