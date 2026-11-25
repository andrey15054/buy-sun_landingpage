-- Anketa copies in Google Drive
ALTER TABLE "leads" ADD COLUMN "drive_status" "DeliveryStatus" NOT NULL DEFAULT 'skipped',
ADD COLUMN "drive_error" TEXT,
ADD COLUMN "drive_folder_id" TEXT,
ADD COLUMN "drive_files" JSONB;

CREATE TABLE "google_drive" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "email" TEXT NOT NULL,
    "refresh_token" TEXT NOT NULL,
    "folder_id" TEXT NOT NULL,
    "connected_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "google_drive_pkey" PRIMARY KEY ("id")
);
