import businessRules from "../knowledge/business-rules.json";
import faq from "../knowledge/faq.json";
import intentAliases from "../knowledge/intent-aliases.json";
import type { Intent } from "./types";

export interface KnowledgeBase {
  getBusinessRules(): typeof businessRules;
  getFaq(): typeof faq;
  getIntentAliases(): Record<string, string[]>;
  getContextForIntent(intent: Intent): string;
  getPrecio(categoria: string): number | null;
  getHorarios(): string;
}

export function createKnowledgeBase(): KnowledgeBase {
  return {
    getBusinessRules() {
      return businessRules;
    },

    getFaq() {
      return faq;
    },

    getIntentAliases() {
      return intentAliases as Record<string, string[]>;
    },

    getContextForIntent(intent: Intent): string {
      const rules = businessRules;
      const lines: string[] = [];

      if (intent === "ALQUILER_EXAMEN" || intent === "SIMULACRO" || intent === "PRACTICA" || intent === "RESERVA") {
        lines.push(`Precios A1: práctica S/${rules.precios.A1.practica}, simulacro individual S/${rules.precios.A1.simulacro_individual}, alquiler vehículo examen S/${rules.precios.A1.alquiler_vehiculo_examen}.`);
        lines.push(`Precios por categoría: A1 S/${rules.precios.A1.practica}, A2A S/${rules.precios.A2A.practica}, A2B S/${rules.precios.A2B.practica}, A3A S/${rules.precios.A3A.practica}, A3B S/${rules.precios.A3B.practica}, A3C S/${rules.precios.A3C.practica}.`);
        lines.push(`El examen de reglas NO se realiza en Conducar.`);
        lines.push(`El examen práctico SÍ se realiza en Conducar para obtención de licencia (${rules.examenes.examen_practico.dias.join(", ")} ${rules.examenes.examen_practico.horario}).`);
        lines.push(`El simulacro se realiza en el circuito donde se realiza el examen práctico (${rules.simulacro.dias.join(", ")} ${rules.simulacro.horario}, ${rules.simulacro.duracion_min} min, solo circuito oficial).`);
        lines.push(`Las prácticas son con instructor profesional (${rules.practica.dias}, ${rules.practica.horario}, ${rules.practica.duracion_min} min). El circuito alterno es una copia idéntica del circuito oficial.`);
      }

      if (intent === "ALQUILER_EXAMEN") {
        lines.push(`Vehículo A1: Kia Picanto 2026 automático (opción mecánica disponible). Recomendación preferente: automático.`);
        lines.push(`A partir de A2B hacia arriba: vehículos mecánicos.`);
        lines.push(`A3B: dato de vehículo NO confirmado. NO inventar.`);
      }

      if (intent === "PAQUETE") {
        lines.push(`Paquetes disponibles SOLO para categoría A1.`);
        lines.push(`P1 S/${rules.paquetes.P1.precio}: ${rules.paquetes.P1.orientacion}.`);
        lines.push(`P2 S/${rules.paquetes.P2.precio}: ${rules.paquetes.P2.orientacion}. Ahorro: S/${rules.paquetes.P2.ahorro}.`);
        lines.push(`P3 S/${rules.paquetes.P3.precio}: ${rules.paquetes.P3.orientacion}.`);
        lines.push(`P5 S/${rules.paquetes.P5.precio}: ${rules.paquetes.P5.orientacion}.`);
        lines.push(`NO inventar paquetes para otras categorías.`);
      }

      if (intent === "HORARIOS") {
        const h = rules.horarios;
        lines.push(`Práctica: ${h.practica_oficial.dias} ${h.practica_oficial.inicio}-${h.practica_oficial.fin}.`);
        lines.push(`Simulacro: ${h.simulacro_oficial.dias} ${h.simulacro_oficial.inicio}-${h.simulacro_oficial.fin}.`);
        lines.push(`Exámenes: ${h.examenes_practicos.dias} ${h.examenes_practicos.inicio}-${h.examenes_practicos.fin}.`);
        lines.push(`Práctica alterno: ${h.practica_alternativo.dias} ${h.practica_alternativo.inicio}-${h.practica_alternativo.fin}.`);
      }

      // Servicios no ofrecidos
      if (intent === "HANDOFF" || intent === "OTROS") {
        lines.push(`Conducar NO realiza: ${rules.servicios_no_ofrecidos.motos}.`);
        lines.push(`Conducar NO realiza: ${rules.servicios_no_ofrecidos.revalidacion}.`);
        lines.push(`Conducar NO realiza: ${rules.servicios_no_ofrecidos.examen_reglas}.`);
      }

      return lines.join("\n");
    },

    getPrecio(categoria: string): number | null {
      const precios = businessRules.precios as Record<string, { practica: number }>;
      return precios[categoria]?.practica ?? null;
    },

    getHorarios(): string {
      const h = businessRules.horarios;
      return [
        `Práctica oficial: ${h.practica_oficial.dias} ${h.practica_oficial.inicio}-${h.practica_oficial.fin}`,
        `Simulacro oficial: ${h.simulacro_oficial.dias} ${h.simulacro_oficial.inicio}-${h.simulacro_oficial.fin}`,
        `Exámenes: ${h.examenes_practicos.dias} ${h.examenes_practicos.inicio}-${h.examenes_practicos.fin}`,
        `Práctica alternativo: ${h.practica_alternativo.dias} ${h.practica_alternativo.inicio}-${h.practica_alternativo.fin}`,
      ].join("; ");
    },
  };
}
