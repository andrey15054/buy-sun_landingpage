-- Anketa link: anketas already in the database get one too
ALTER TABLE "leads" ADD COLUMN "share_token" TEXT;

UPDATE "leads"
SET "share_token" = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
WHERE "type" = 'anketa';

CREATE UNIQUE INDEX "leads_share_token_key" ON "leads"("share_token");
