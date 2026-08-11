-- CreateEnum
CREATE TYPE "ComplaintStatus" AS ENUM ('PENDING', 'OPEN', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ComplaintType" AS ENUM ('QUEJA', 'RECLAMO', 'SUGERENCIA');

-- CreateEnum
CREATE TYPE "ValidationAction" AS ENUM ('CONFIRM', 'CANCEL', 'CLOSE', 'REPLY', 'RESOLVE');

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "complaintId" INTEGER;

-- CreateTable
CREATE TABLE "Complaint" (
    "id" SERIAL NOT NULL,
    "phone" TEXT NOT NULL,
    "clientName" TEXT,
    "type" "ComplaintType" NOT NULL,
    "description" TEXT NOT NULL,
    "expectedSolution" TEXT,
    "status" "ComplaintStatus" NOT NULL DEFAULT 'PENDING',
    "resolutionNote" TEXT,
    "ticketId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "Complaint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ValidationRecord" (
    "id" SERIAL NOT NULL,
    "phone" TEXT NOT NULL,
    "action" "ValidationAction" NOT NULL,
    "note" TEXT,
    "ticketId" INTEGER,
    "reservationId" INTEGER,
    "operator" TEXT NOT NULL DEFAULT 'operador',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ValidationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Complaint_ticketId_key" ON "Complaint"("ticketId");

-- CreateIndex
CREATE INDEX "ValidationRecord_createdAt_idx" ON "ValidationRecord"("createdAt");

-- CreateIndex
CREATE INDEX "ValidationRecord_phone_idx" ON "ValidationRecord"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_complaintId_key" ON "Ticket"("complaintId");

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

