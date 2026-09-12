/*
  Warnings:

  - You are about to drop the column `text` on the `Message` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Message" DROP COLUMN "text",
ADD COLUMN     "caption" TEXT,
ADD COLUMN     "fileSize" INTEGER,
ADD COLUMN     "mediaId" TEXT,
ADD COLUMN     "metaMediaId" TEXT,
ADD COLUMN     "mimeType" TEXT,
ADD COLUMN     "source" TEXT DEFAULT 'AI',
ADD COLUMN     "storagePath" TEXT;
