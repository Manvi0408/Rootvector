-- Per-user incidents + GitHub issue linkage ("RootVector solved this").
ALTER TABLE "Incident" ADD COLUMN "userId" TEXT;
ALTER TABLE "Incident" ADD COLUMN "repoFullName" TEXT;
ALTER TABLE "Incident" ADD COLUMN "issueNumber" INTEGER;

CREATE INDEX "Incident_userId_idx" ON "Incident"("userId");
