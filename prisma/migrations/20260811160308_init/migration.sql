-- CreateEnum
CREATE TYPE "Circuit" AS ENUM ('OFFICIAL', 'ALTERNATIVE');

-- CreateEnum
CREATE TYPE "Activity" AS ENUM ('PRACTICE', 'SIMULACRO', 'EXAM');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('PENDING_PAYMENT', 'AWAITING_VOUCHER', 'PENDING_HUMAN', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('PENDING', 'OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "TicketReason" AS ENUM ('NO_SOLUTION', 'PAYMENT', 'TRAMITE', 'CANCEL', 'REPROGRAM', 'NO_SHOW', 'RECATEGORIZATION', 'UPGRADE', 'OTHER');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('BOT', 'HUMAN', 'CLOSED');

-- CreateTable
CREATE TABLE "Category" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "vehicle" TEXT NOT NULL,
    "price" DECIMAL(65,30) NOT NULL,
    "durationMin" INTEGER NOT NULL DEFAULT 30,
    "order" INTEGER NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleRule" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "activity" "Activity" NOT NULL,
    "circuit" "Circuit" NOT NULL,
    "days" TEXT NOT NULL,
    "start" TEXT NOT NULL,
    "end" TEXT NOT NULL,
    "order" INTEGER NOT NULL,

    CONSTRAINT "ScheduleRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Package" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(65,30) NOT NULL,
    "items" JSONB NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "Package_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" SERIAL NOT NULL,
    "name" TEXT,
    "phone" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reservation" (
    "id" SERIAL NOT NULL,
    "clientId" INTEGER NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "activity" "Activity" NOT NULL,
    "circuit" "Circuit" NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "durationMin" INTEGER NOT NULL,
    "price" DECIMAL(65,30) NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "paymentMethod" TEXT,
    "packageId" INTEGER,
    "voucherPath" TEXT,
    "reminder24h" BOOLEAN NOT NULL DEFAULT false,
    "reminder2h" BOOLEAN NOT NULL DEFAULT false,
    "ticketId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" SERIAL NOT NULL,
    "phone" TEXT NOT NULL,
    "reason" "TicketReason" NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'PENDING',
    "summary" TEXT NOT NULL,
    "context" JSONB NOT NULL,
    "reservationId" INTEGER,
    "closedNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" SERIAL NOT NULL,
    "phone" TEXT NOT NULL,
    "status" "ConversationStatus" NOT NULL DEFAULT 'BOT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "text" TEXT,
    "mediaType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Category_code_key" ON "Category"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Package_code_key" ON "Package"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Client_phone_key" ON "Client"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_ticketId_key" ON "Reservation"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_reservationId_key" ON "Ticket"("reservationId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_phone_key" ON "Conversation"("phone");

-- CreateIndex
CREATE INDEX "Message_phone_idx" ON "Message"("phone");

-- CreateIndex
CREATE INDEX "Message_createdAt_idx" ON "Message"("createdAt");

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;
