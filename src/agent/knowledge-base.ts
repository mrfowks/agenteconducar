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
        lines.push(`Precios por sesión: A1 S/${rules.precios.A1}, A2A S/${rules.precios.A2A}, A2B S/${rules.precios.A2B}, A3A S/${rules.precios.A3A}, A3B S/${rules.precios.A3B}, A3C S/${rules.precios.A3C}.`);
        lines.push(`El examen de reglas NO se realiza en Conducar.`);
        lines.push(`El examen práctico SÍ se realiza en Conducar para obtención de licencia.`);
        lines.push(`El simulacro se realiza en el circuito donde se realiza el examen práctico.`);
        lines.push(`Las prácticas son con instructor. El circuito alterno es una copia idéntica del circuito oficial.`);
      }

      if (intent === "HORARIOS") {
        const h = rules.horarios;
        lines.push(`Práctica circuito oficial: ${h.practica_oficial.dias} de ${h.practica_oficial.inicio} a ${h.practica_oficial.fin}.`);
        lines.push(`Simulacro circuito oficial: ${h.simulacro_oficial.dias} de ${h.simulacro_oficial.inicio} a ${h.simulacro_oficial.fin}.`);
        lines.push(`Exámenes: ${h.examenes.dias} de ${h.examenes.inicio} a ${h.examenes.fin}.`);
        lines.push(`Práctica circuito alternativo: ${h.practica_alternativo.dias} de ${h.practica_alternativo.inicio} a ${h.practica_alternativo.fin}.`);
      }

      return lines.join("\n");
    },

    getPrecio(categoria: string): number | null {
      const precios = businessRules.precios as Record<string, number>;
      return precios[categoria] ?? null;
    },

    getHorarios(): string {
      const h = businessRules.horarios;
      return [
        `Práctica oficial: ${h.practica_oficial.dias} ${h.practica_oficial.inicio}-${h.practica_oficial.fin}`,
        `Simulacro oficial: ${h.simulacro_oficial.dias} ${h.simulacro_oficial.inicio}-${h.simulacro_oficial.fin}`,
        `Exámenes: ${h.examenes.dias} ${h.examenes.inicio}-${h.examenes.fin}`,
        `Práctica alternativo: ${h.practica_alternativo.dias} ${h.practica_alternativo.inicio}-${h.practica_alternativo.fin}`,
      ].join("; ");
    },
  };
}
