import type { Intent, ConversationStateData } from "./types";
import type { ResolvedContext } from "./context-resolver";
import { createKnowledgeBase } from "./knowledge-base";

// ── Tipos de recomendación ──────────────────────────────────────

export type RecommendationType =
  | "PACKAGE"           // Paquete P1-P5
  | "SERVICE"           // Práctica o simulacro individual
  | "VEHICLE"           // Vehículo según categoría
  | "CONTEXTUAL_SIMULACRO" // Simulacro como preparación para examen próximo
  | "DIAGNOSTIC";       // Necesita más información para recomendar

export interface Recommendation {
  type: RecommendationType;
  target: string;                // Ej: "P2", "SIMULACRO", "Kia Picanto automático"
  reason: string;                // Explicación legible
  confidence: number;            // 0-1
  supportingFacts: string[];     // Datos que soportan la recomendación
  alternatives: string[];        // Otras opciones si rechaza
  estimatedValue: {
    price: number | null;        // S/ del servicio/paquete
    savings: number | null;      // S/ de ahorro vs individual
    separateTotal: number | null; // S/ total por separado
  };
  requiresConfirmation: boolean; // Siempre true para side-effects
}

export interface RecommendationInput {
  activeIntent: Intent | null;
  slots: Record<string, unknown>;
  state: ConversationStateData;
  context: ResolvedContext;
}

export interface RecommendationResult {
  recommendation: Recommendation | null;
  diagnosisNeeded: boolean;      // Si necesita más información para recomendar
  diagnosisQuestions: string[];  // Preguntas de diagnóstico
}

// ── Helpers de contexto ─────────────────────────────────────────

/**
 * Verifica si el cliente ha expresado explícitamente que quiere práctica intensiva.
 * NO usa messageCount como señal comercial.
 */
function hasExplicitIntensiveSignal(slots: Record<string, unknown>): boolean {
  if (slots.practica_intensiva === true) return true;
  if (typeof slots.cantidad_practicas === "number" && slots.cantidad_practicas >= 3) return true;
  return false;
}

/**
 * Verifica si hay evidencia explícita de combinación de servicios:
 * necesita vehículo para examen + le interesa simulacro.
 * Requerido para recomendar P5.
 */
function hasCombinationContext(slots: Record<string, unknown>): boolean {
  const wantsVehicle = slots.necesita_vehiculo === true || slots.alquiler === true;
  const wantsSimulacro = slots.necesita_simulacro === true || slots.interes_simulacro === true;
  return wantsVehicle && wantsSimulacro;
}

/**
 * Verifica si el contexto indica que el examen está próximo.
 * Detecta: isExamDay (hoy es día de examen) O examen_fecha en slots.
 */
function hasExamProximity(
  slots: Record<string, unknown>,
  stateSlots: Record<string, unknown>,
  isExamDay: boolean,
): boolean {
  if (isExamDay) return true;
  // El usuario mencionó la fecha de su examen (extraído por slot-manager)
  if (stateSlots.examen_fecha || slots.examen_fecha) return true;
  // La fecha de práctica cae en día de examen (martes, jueves, sábado)
  const EXAM_DAYS = ["martes", "jueves", "sabado", "sábado"];
  const fecha = (slots.fecha as string) ?? (stateSlots.fecha as string);
  if (fecha && EXAM_DAYS.includes(fecha)) return true;
  return false;
}

// ── Motor de recomendación ──────────────────────────────────────

/**
 * Evalúa el contexto del cliente y genera una recomendación estructurada.
 * NO cambia activeIntent. NO genera respuesta final. NO ejecuta side effects.
 */
export function evaluateRecommendation(input: RecommendationInput): RecommendationResult {
  const { activeIntent, slots, state, context } = input;
  const kb = createKnowledgeBase();
  const rules = kb.getBusinessRules();

  const categoria = (slots.categoria as string) ?? context.clientProfile.lastCategory;
  const actividad = (slots.actividad as string) ?? context.clientProfile.lastActivity;

  // ── Regla 0: Si la intención es PAQUETE, no recomendar otro paquete ──
  if (activeIntent === "PAQUETE") {
    return { recommendation: null, diagnosisNeeded: false, diagnosisQuestions: [] };
  }

  // ── Regla 1: Categoría ≠ A1 → NO inventar paquetes ──
  if (categoria && categoria !== "A1") {
    // Para otras categorías, solo recomendar servicio individual si aplica
    if (activeIntent === "PRACTICA" || activeIntent === "SIMULACRO") {
      return {
        recommendation: {
          type: "SERVICE",
          target: actividad === "simulacro" ? "SIMULACRO" : "PRACTICA",
          reason: `Servicio individual para categoría ${categoria}.`,
          confidence: 0.8,
          supportingFacts: [`Categoría ${categoria}`, `Servicio: ${actividad ?? "práctica"}`],
          alternatives: [],
          estimatedValue: {
            price: (rules.precios as Record<string, { practica: number }>)[categoria]?.practica ?? null,
            savings: null,
            separateTotal: null,
          },
          requiresConfirmation: true,
        },
        diagnosisNeeded: false,
        diagnosisQuestions: [],
      };
    }

    // Para ALQUILER_EXAMEN, recomendar vehículo según categoría
    if (activeIntent === "ALQUILER_EXAMEN") {
      return recommendVehicle(categoria, rules);
    }

    return { recommendation: null, diagnosisNeeded: false, diagnosisQuestions: [] };
  }

  // ── Regla 2: Sin categoría definida → pedir diagnóstico ──
  if (!categoria) {
    return {
      recommendation: null,
      diagnosisNeeded: true,
      diagnosisQuestions: [
        "¿Qué categoría de licencia necesitas? (A1 para auto, A2A para auto, A2B para camioneta, A3A para bus, A3B para camión, A3C para camión grande)",
      ],
    };
  }

  // ── A partir de aquí: categoría A1 ──

  // ── Regla 3: Examen próximo + práctica → recomendar simulacro contextual ──
  // Detecta: isExamDay (hoy es día de examen) O examen_fecha en slots O fecha de práctica en día de examen
  if (hasExamProximity(slots, state.slots, context.temporalContext.isExamDay)) {
    if (activeIntent === "PRACTICA" || activeIntent === "SIMULACRO") {
      // Verificar si ya tiene simulacro agendado
      const hasSimulacroScheduled = state.slots.actividad === "simulacro" || state.lastRecommendationType === "CONTEXTUAL_SIMULACRO";

      if (!hasSimulacroScheduled) {
        return {
          recommendation: {
            type: "CONTEXTUAL_SIMULACRO",
            target: "SIMULACRO",
            reason: "Dado que tu examen está cerca, el simulacro te permite practicar en la pista oficial de 5:30 AM a 7:30 AM, con instructor.",
            confidence: 0.85,
            supportingFacts: [
              "Examen próximo detectado",
              "Simulacro: martes/jueves/sábado 5:30-7:30 AM, pista oficial",
              "Duración individual: 20 minutos",
            ],
            alternatives: ["PRACTICA"],
            estimatedValue: {
              price: rules.precios.A1.simulacro_individual,
              savings: null,
              separateTotal: null,
            },
            requiresConfirmation: true,
          },
          diagnosisNeeded: false,
          diagnosisQuestions: [],
        };
      }
    }
  }

  // ── Regla 4: SIMULACRO solo → simulacro individual (SERVICE) ──
  // SIMULACRO como intención aislada NO implica P5 automáticamente.
  // P5 solo si hay combinación explícita de vehículo + simulacro.
  if (activeIntent === "SIMULACRO") {
    if (hasCombinationContext(slots)) {
      return {
        recommendation: {
          type: "PACKAGE",
          target: "P5",
          reason: "El Paquete 5 incluye 3 prácticas en circuito oficial, alquiler de vehículo para tu examen y una vuelta gratis de simulacro.",
          confidence: 0.85,
          supportingFacts: [
            "3 prácticas de 30 min en circuito oficial",
            "Alquiler de vehículo para examen",
            "1 vuelta gratis de simulacro (martes/jueves/sábado 5:30-7:30 AM)",
            `Precio: S/${rules.paquetes.P5.precio}`,
          ],
          alternatives: ["P2", "SIMULACRO individual"],
          estimatedValue: {
            price: rules.paquetes.P5.precio,
            savings: null,
            separateTotal: null,
          },
          requiresConfirmation: true,
        },
        diagnosisNeeded: false,
        diagnosisQuestions: [],
      };
    }
    return {
      recommendation: {
        type: "SERVICE",
        target: "SIMULACRO",
        reason: "Simulacro individual de examen práctico. Realizado en circuito oficial, martes/jueves/sábado de 5:30 a 7:30 AM, con instructor profesional.",
        confidence: 0.9,
        supportingFacts: [
          "Simulacro individual en circuito oficial",
          "Duración: 20 minutos",
          "Martes/jueves/sábado 5:30-7:30 AM",
          "Con instructor profesional",
        ],
        alternatives: ["P5", "PRACTICA"],
        estimatedValue: {
          price: rules.precios.A1.simulacro_individual,
          savings: null,
          separateTotal: null,
        },
        requiresConfirmation: true,
      },
      diagnosisNeeded: false,
      diagnosisQuestions: [],
    };
  }

  // ── Regla 5: Cliente nuevo sin trámites → Paquete 1 ──
  if (
    context.clientProfile.hasReservations === false &&
    context.conversationContext.isNewUser &&
    activeIntent !== "PRACTICA"
  ) {
    return {
      recommendation: {
        type: "PACKAGE",
        target: "P1",
        reason: "Si todavía no has realizado ninguno de tus trámites, el Paquete 1 te conviene porque tienes todo incluido y Conducar te orienta durante el proceso completo.",
        confidence: 0.9,
        supportingFacts: [
          "No tiene trámites iniciados",
          "Incluye: examen médico, pagos/derechos, balotario, prácticas alternativo + oficial + vehículo + simulacro",
          "Acompañamiento integral",
        ],
        alternatives: ["P2", "P3", "P5"],
        estimatedValue: {
          price: rules.paquetes.P1.precio,
          savings: null,
          separateTotal: null,
        },
        requiresConfirmation: true,
      },
      diagnosisNeeded: false,
      diagnosisQuestions: [],
    };
  }

  // ── Regla 6: ALQUILER_EXAMEN solo → vehículo individual ──
  // ALQUILER_EXAMEN como intención aislada NO implica P5 automáticamente.
  // P5 solo si hay combinación explícita de vehículo + simulacro.
  if (activeIntent === "ALQUILER_EXAMEN") {
    if (hasCombinationContext(slots)) {
      return {
        recommendation: {
          type: "PACKAGE",
          target: "P5",
          reason: "El Paquete 5 incluye 3 prácticas en circuito oficial, alquiler de vehículo para tu examen y una vuelta gratis de simulacro.",
          confidence: 0.85,
          supportingFacts: [
            "3 prácticas de 30 min en circuito oficial",
            "Alquiler de vehículo para examen",
            "1 vuelta gratis de simulacro (martes/jueves/sábado 5:30-7:30 AM)",
            `Precio: S/${rules.paquetes.P5.precio}`,
          ],
          alternatives: ["P2", "SIMULACRO individual"],
          estimatedValue: {
            price: rules.paquetes.P5.precio,
            savings: null,
            separateTotal: null,
          },
          requiresConfirmation: true,
        },
        diagnosisNeeded: false,
        diagnosisQuestions: [],
      };
    }
    return recommendVehicle(categoria, rules);
  }

  // ── Regla 7: PRACTICA + señal explícita de intensidad → Paquete 3 ──
  // P3 solo se recomienda cuando el cliente EXPRESA CLARAMENTE que quiere
  // práctica intensiva. NO se usa messageCount como señal comercial.
  if (activeIntent === "PRACTICA" && hasExplicitIntensiveSignal(slots)) {
    return {
      recommendation: {
        type: "PACKAGE",
        target: "P3",
        reason: "Si quieres preparación intensiva, el Paquete 3 incluye prácticas tanto en circuito alternativo como oficial, más el vehículo para tu examen.",
        confidence: 0.85,
        supportingFacts: [
          "2 prácticas de 45 min en circuito alternativo",
          "4 prácticas de 30 min en circuito oficial",
          "Alquiler de vehículo para examen",
          "Instructor profesional",
        ],
        alternatives: ["P2", "P5", "PRACTICA individual"],
        estimatedValue: {
          price: rules.paquetes.P3.precio,
          savings: null,
          separateTotal: null,
        },
        requiresConfirmation: true,
      },
      diagnosisNeeded: false,
      diagnosisQuestions: [],
    };
  }

  // ── Regla 8: PRACTICA + tiene experiencia → Paquete 2 ──
  if (activeIntent === "PRACTICA" && context.clientProfile.hasReservations) {
    return {
      recommendation: {
        type: "PACKAGE",
        target: "P2",
        reason: "El Paquete 2 incluye 1 hora de práctica en circuito oficial (2 x 30 min) más el alquiler de vehículo para tu examen. Por separado costaría S/180, con el paquete ahorras S/20.",
        confidence: 0.9,
        supportingFacts: [
          "2 prácticas de 30 min = 1 hora en circuito oficial",
          "Incluye alquiler de vehículo para examen",
          "Instructor profesional",
          `Precio: S/${rules.paquetes.P2.precio}`,
          `Ahorro: S/${rules.paquetes.P2.ahorro} vs S/${rules.paquetes.P2.precio_separado} por separado`,
        ],
        alternatives: ["PRACTICA individual", "P5"],
        estimatedValue: {
          price: rules.paquetes.P2.precio,
          savings: rules.paquetes.P2.ahorro,
          separateTotal: rules.paquetes.P2.precio_separado,
        },
        requiresConfirmation: true,
      },
      diagnosisNeeded: false,
      diagnosisQuestions: [],
    };
  }

  // ── Regla 9: Sin intención clara + sin trámites → diagnóstico ──
  if (!activeIntent && !context.clientProfile.hasReservations) {
    return {
      recommendation: null,
      diagnosisNeeded: true,
      diagnosisQuestions: [
        "¿Ya has practicado antes o estás empezando?",
        "¿Qué categoría de licencia necesitas?",
      ],
    };
  }

  // ── Default: sin recomendación ──
  return { recommendation: null, diagnosisNeeded: false, diagnosisQuestions: [] };
}

// ── Recomendación de vehículo ───────────────────────────────────

function recommendVehicle(
  categoria: string,
  rules: ReturnType<ReturnType<typeof createKnowledgeBase>["getBusinessRules"]>,
): RecommendationResult {
  const vehiculo = rules.vehiculos[categoria as keyof typeof rules.vehiculos];

  if (!vehiculo) {
    return {
      recommendation: null,
      diagnosisNeeded: false,
      diagnosisQuestions: [],
    };
  }

  // A3B: no inventar
  if ("tipo" in vehiculo && vehiculo.tipo === "no_confirmado") {
    return {
      recommendation: null,
      diagnosisNeeded: false,
      diagnosisQuestions: [],
    };
  }

  let target: string;
  let reason: string;
  const facts: string[] = [];

  if (categoria === "A1") {
    target = "Kia Picanto 2026 automático";
    reason = "Para A1 recomendamos el Kia Picanto 2026 automático. El automático facilita la conducción y evita complicaciones como cambios de marcha. También existe opción mecánica.";
    facts.push("Kia Picanto 2026 automático (preferencia)");
    facts.push("Opción mecánica también disponible");
    facts.push("Recomendación: automático para facilitar conducción");
  } else if (categoria === "A2B") {
    target = "minivan mecánica";
    reason = "Para A2B el vehículo es una minivan mecánica.";
    facts.push("A2B: minivan mecánica");
    facts.push("A partir de A2B: vehículos mecánicos");
  } else if (categoria === "A3A") {
    target = "Cusco mecánica";
    reason = "Para A3A el vehículo es un Cusco mecánico.";
    facts.push("A3A: Cusco mecánico");
  } else if (categoria === "A3C") {
    target = "Hyundai 0 km mecánico";
    reason = "Para A3C el vehículo es un camión Hyundai 0 km mecánico. Prácticas y examen con este vehículo.";
    facts.push("A3C: camión Hyundai 0 km mecánico");
  } else {
    target = "vehículo según categoría";
    reason = `Vehículo para categoría ${categoria}.`;
    facts.push(`Categoría: ${categoria}`);
  }

  return {
    recommendation: {
      type: "VEHICLE",
      target,
      reason,
      confidence: 0.9,
      supportingFacts: facts,
      alternatives: [],
      estimatedValue: { price: null, savings: null, separateTotal: null },
      requiresConfirmation: false,
    },
    diagnosisNeeded: false,
    diagnosisQuestions: [],
  };
}
