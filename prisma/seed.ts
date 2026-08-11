import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Sembrando base de conocimiento de Conducar...");

  const categories: Prisma.CategoryCreateInput[] = [
    { code: "A1", vehicle: "auto", price: 60, durationMin: 30, order: 1 },
    { code: "A2A", vehicle: "auto", price: 60, durationMin: 30, order: 2 },
    { code: "A2B", vehicle: "camioneta/van", price: 70, durationMin: 30, order: 3 },
    { code: "A3A", vehicle: "ómnibus/bus", price: 100, durationMin: 30, order: 4 },
    { code: "A3B", vehicle: "camión", price: 100, durationMin: 30, order: 5 },
    { code: "A3C", vehicle: "—", price: 100, durationMin: 30, order: 6 },
  ];

  for (const c of categories) {
    await prisma.category.upsert({
      where: { code: c.code },
      update: { vehicle: c.vehicle, price: c.price, durationMin: c.durationMin, order: c.order },
      create: c,
    });
  }
  console.log("✅ Categorías (A1, A2A, A2B, A3A, A3B, A3C)");

  // JS getDay(): 0 = Domingo, 1 = Lunes ... 6 = Sábado
  const scheduleRules: Prisma.ScheduleRuleCreateInput[] = [
    {
      name: "Práctica en circuito oficial",
      activity: "PRACTICE",
      circuit: "OFFICIAL",
      days: "1,3,5,0",
      start: "08:00",
      end: "17:30",
      order: 1,
    },
    {
      name: "Simulacro en circuito oficial",
      activity: "SIMULACRO",
      circuit: "OFFICIAL",
      days: "2,4,6",
      start: "05:30",
      end: "07:30",
      order: 2,
    },
    {
      name: "Exámenes prácticos oficiales",
      activity: "EXAM",
      circuit: "OFFICIAL",
      days: "2,4,6",
      start: "08:00",
      end: "16:00",
      order: 3,
    },
    {
      name: "Práctica en circuito alternativo",
      activity: "PRACTICE",
      circuit: "ALTERNATIVE",
      days: "0,1,2,3,4,5,6",
      start: "08:00",
      end: "17:30",
      order: 4,
    },
  ];

  await prisma.scheduleRule.deleteMany({});
  await prisma.scheduleRule.createMany({ data: scheduleRules });
  console.log("✅ Reglas de agenda (oficial/alternativo, simulacro, exámenes)");

  const packages: Prisma.PackageCreateInput[] = [
    {
      code: "P1",
      name: "Paquete 1",
      price: 680,
      items: [
        "1 examen médico",
        "3 pagos de derechos de examen (normas, manejo y expedición de licencia)",
        "1 balotario desarrollado",
        "2 prácticas de 45 minutos en el circuito alternativo",
        "5 prácticas de 30 minutos en el circuito oficial",
        "1 alquiler de vehículo para el examen",
        "1 vuelta gratis de simulacro",
      ],
      description:
        "Paquete completo de obtención de licencia: examen médico, derechos de examen, balotario, 7 prácticas y alquiler de vehículo para el examen.",
    },
    {
      code: "P2",
      name: "Paquete 2",
      price: 160,
      items: [
        "2 prácticas de 30 minutos en el circuito oficial",
        "1 alquiler de vehículo para el examen",
      ],
      description: "Prácticas básicas en el circuito oficial con alquiler de vehículo para el examen.",
    },
    {
      code: "P3",
      name: "Paquete 3",
      price: 360,
      items: [
        "2 prácticas de 45 minutos en el circuito alternativo",
        "4 prácticas de 30 minutos en el circuito oficial",
        "1 alquiler de vehículo para el examen",
      ],
      description: "Mayor cantidad de práctica combinando circuito alternativo y oficial.",
    },
    {
      code: "P4",
      name: "Paquete 4",
      price: 420,
      items: [
        "1 examen médico",
        "3 pagos de derechos de examen (normas, manejo y expedición de licencia)",
        "1 balotario desarrollado",
        "2 prácticas de 30 minutos en el circuito oficial",
        "1 alquiler de vehículo para el examen",
      ],
      description: "Trámites de licencia (médico, derechos y balotario) con 2 prácticas y alquiler de vehículo.",
    },
    {
      code: "P5",
      name: "Paquete 5",
      price: 250,
      items: [
        "3 prácticas de 30 minutos en el circuito oficial",
        "1 alquiler de vehículo para el examen",
        "1 vuelta gratis de simulacro",
      ],
      description: "Prácticas en circuito oficial, alquiler de vehículo y una vuelta gratis de simulacro.",
    },
  ];

  for (const p of packages) {
    await prisma.package.upsert({
      where: { code: p.code },
      update: { price: p.price, items: p.items, description: p.description },
      create: p,
    });
  }
  console.log("✅ Paquetes promocionales (P1 a P5)");

  console.log("🎉 Base de conocimiento lista.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
