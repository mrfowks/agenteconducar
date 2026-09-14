import type { ConversationStateData } from "./types";
import type { Recommendation } from "./recommendation-engine";
import { TOOL_EXECUTORS } from "./tools";

// ── Tipos ───────────────────────────────────────────────────────

export type ToolResultStatus =
  | "SUCCESS"
  | "NO_AVAILABILITY"
  | "VALIDATION_ERROR"
  | "BUSINESS_ERROR"
  | "TECHNICAL_ERROR";

export interface ToolExecutionResult {
  status: ToolResultStatus;
  tool: string;
  result: unknown;
  error?: string;
}

export interface ToolExecutionInput {
  action: string;          // Nombre de la herramienta
  state: ConversationStateData;
  slots: Record<string, unknown>;
  recommendation: Recommendation | null;
  phone: string | null;
  conversationId: number | null;
}

// ── Validación pre-ejecución ────────────────────────────────────

/**
 * Valida que los datos son suficientes para ejecutar la herramienta.
 * NO ejecuta la herramienta, solo valida.
 */
export function validatePreExecution(input: ToolExecutionInput): { valid: boolean; reason?: string } {
  const { action, slots } = input;

  // Validaciones comunes
  if (!action) {
    return { valid: false, reason: "Acción no especificada" };
  }

  // Validaciones específicas por herramienta
  switch (action) {
    case "crear_reserva": {
      // Requiere: actividad, categoria, circuito, fecha, hora
      if (!slots.actividad) return { valid: false, reason: "Falta actividad" };
      if (!slots.categoria) return { valid: false, reason: "Falta categoría" };
      if (!slots.circuito) return { valid: false, reason: "Falta circuito" };
      if (!slots.fecha) return { valid: false, reason: "Falta fecha" };
      if (!slots.hora) return { valid: false, reason: "Falta hora" };

      // Validar que fecha no sea relativa sin resolver
      const fecha = String(slots.fecha);
      if (isRelativeDate(fecha)) {
        return { valid: false, reason: `Fecha relativa no resuelta: "${fecha}". Debe resolverse contra calendario.` };
      }

      // Validar que hora no sea ambigua
      const hora = String(slots.hora);
      if (isAmbiguousTime(hora)) {
        return { valid: false, reason: `Hora ambigua: "${hora}". Debe especificar AM/PM o usar formato 24h.` };
      }

      return { valid: true };
    }

    case "consultar_disponibilidad": {
      if (!slots.fecha) return { valid: false, reason: "Falta fecha" };
      if (!slots.circuito) return { valid: false, reason: "Falta circuito" };
      if (!slots.actividad) return { valid: false, reason: "Falta actividad" };
      return { valid: true };
    }

    case "consultar_fechas_disponibles": {
      if (!slots.circuito) return { valid: false, reason: "Falta circuito" };
      if (!slots.actividad) return { valid: false, reason: "Falta actividad" };
      return { valid: true };
    }

    case "consultar_actividades_dia": {
      if (!slots.fecha) return { valid: false, reason: "Falta fecha" };
      return { valid: true };
    }

    case "registrar_reclamo": {
      if (!slots.tipo) return { valid: false, reason: "Falta tipo de reclamo" };
      if (!slots.descripcion) return { valid: false, reason: "Falta descripción del reclamo" };
      return { valid: true };
    }

    // Consultas sin restricciones estrictas
    case "consultar_agenda":
    case "consultar_paquetes":
    case "consultar_categorias":
    case "consultar_informacion_licencia":
    case "consultar_recategorizacion":
    case "consultar_metodos_pago":
    case "consultar_mis_reservas":
    case "derivar_a_humano":
      return { valid: true };

    default:
      return { valid: false, reason: `Herramienta desconocida: ${action}` };
  }
}

/**
 * ¿La fecha es relativa (no resuelta)?
 */
function isRelativeDate(fecha: string): boolean {
  const relativePatterns = [
    /^(hoy|ma[ñn]ana|pasado\s+ma[ñn]ana)$/i,
    /^(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)$/i,
    /^(este|pr[oó]ximo|proximo)\s+\w+$/i,
    /^el\s+\w+$/i,
    /^\d{1,2}\/\d{1,2}$/, // dd/mm no es relativo pero tampoco está resuelto contra calendario
  ];
  return relativePatterns.some((p) => p.test(fecha.trim()));
}

/**
 * ¿La hora es ambigua (sin AM/PM y sin formato 24h claro)?
 */
function isAmbiguousTime(hora: string): boolean {
  // Formato 24h explícito: "10:00", "22:30"
  if (/^\d{1,2}:\d{2}$/.test(hora)) return false;
  // Con AM/PM: "10 AM", "3:30 PM"
  if (/[ap]\.?m\.?/i.test(hora)) return false;
  // Todo lo demás es ambiguo
  return true;
}

// ── Ejecución ───────────────────────────────────────────────────

/**
 * Ejecuta una herramienta real de Conducar.
 * REGLA CRÍTICA: solo se llama DESPUÉS de ConfirmationGate autorizado.
 * Valida pre-condiciones antes de ejecutar.
 */
export async function executeTool(input: ToolExecutionInput): Promise<ToolExecutionResult> {
  const { action, state, slots, recommendation, phone, conversationId } = input;

  // 1. Validar pre-ejecución
  const validation = validatePreExecution(input);
  if (!validation.valid) {
    return {
      status: "VALIDATION_ERROR",
      tool: action,
      result: null,
      error: validation.reason,
    };
  }

  // 2. Buscar el ejecutor real
  const executor = TOOL_EXECUTORS[action];
  if (!executor) {
    return {
      status: "TECHNICAL_ERROR",
      tool: action,
      result: null,
      error: `Herramienta no encontrada: ${action}`,
    };
  }

  // 3. Construir argumentos según la herramienta
  const args = buildToolArgs(action, slots, recommendation, phone, conversationId);

  // 4. Ejecutar con manejo de errores
  try {
    const result = await executor(phone ?? `cw-${conversationId}`, args);

    // 5. Determinar status del resultado
    const status = interpretResult(action, result);

    return {
      status,
      tool: action,
      result,
    };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Clasificar el error
    if (errorMessage.includes("no disponible") || errorMessage.includes("No hay")) {
      return {
        status: "NO_AVAILABILITY",
        tool: action,
        result: null,
        error: errorMessage,
      };
    }

    if (
      errorMessage.includes("inválid") ||
      errorMessage.includes("requerido") ||
      errorMessage.includes("no existe") ||
      errorMessage.includes("Falta")
    ) {
      return {
        status: "VALIDATION_ERROR",
        tool: action,
        result: null,
        error: errorMessage,
      };
    }

    if (
      errorMessage.includes("Ya tienes una reserva pendiente") ||
      errorMessage.includes("no incluye") ||
      errorMessage.includes("Duración no válida")
    ) {
      return {
        status: "BUSINESS_ERROR",
        tool: action,
        result: null,
        error: errorMessage,
      };
    }

    return {
      status: "TECHNICAL_ERROR",
      tool: action,
      result: null,
      error: errorMessage,
    };
  }
}

// ── Construcción de argumentos ──────────────────────────────────

function buildToolArgs(
  action: string,
  slots: Record<string, unknown>,
  recommendation: Recommendation | null,
  phone: string | null,
  conversationId: number | null,
): Record<string, unknown> {
  switch (action) {
    case "crear_reserva":
      return {
        actividad: slots.actividad,
        categoria: slots.categoria,
        circuito: slots.circuito,
        fecha: slots.fecha,
        hora_inicio: slots.hora,
        duracion_min: slots.actividad === "simulacro" ? 20 : 30,
        paquete: recommendation?.type === "PACKAGE" ? recommendation.target : undefined,
      };

    case "consultar_disponibilidad":
      return {
        fecha: slots.fecha,
        circuito: slots.circuito,
        actividad: slots.actividad,
        duracion_min: slots.actividad === "simulacro" ? 20 : 30,
      };

    case "consultar_actividades_dia":
      return {
        fecha: slots.fecha,
      };

    case "consultar_fechas_disponibles":
      return {
        circuito: slots.circuito ?? "oficial",
        actividad: slots.actividad === "simulacro" ? "simulacro" : "practica",
      };

    case "consultar_paquetes":
      return slots.codigo ? { codigo: slots.codigo } : {};

    case "consultar_agenda":
    case "consultar_categorias":
    case "consultar_informacion_licencia":
    case "consultar_recategorizacion":
    case "consultar_metodos_pago":
    case "consultar_mis_reservas":
      return {};

    case "derivar_a_humano":
      return {
        motivo: slots.motivo ?? "sin_solucion",
        detalle: slots.detalle ?? "Derivado por el orquestador conversacional",
      };

    case "registrar_reclamo":
      return {
        tipo: slots.tipo,
        descripcion: slots.descripcion,
        solucion_esperada: slots.solucion_esperada,
      };

    default:
      return {};
  }
}

// ── Interpretación de resultados ────────────────────────────────

function interpretResult(action: string, result: unknown): ToolResultStatus {
  if (!result) return "TECHNICAL_ERROR";

  const resultStr = typeof result === "string" ? result : JSON.stringify(result);

  // Resultados específicos por herramienta
  if (action === "crear_reserva") {
    if (resultStr.includes("no disponible") || resultStr.includes("No hay")) {
      return "NO_AVAILABILITY";
    }
    if (resultStr.includes("error") || resultStr.includes("Error")) {
      return "BUSINESS_ERROR";
    }
    return "SUCCESS";
  }

  if (action === "consultar_disponibilidad") {
    if (resultStr.includes("disponible\":false") || resultStr.includes("no hay")) {
      return "NO_AVAILABILITY";
    }
    return "SUCCESS";
  }

  if (action === "consultar_fechas_disponibles") {
    if (resultStr.includes("disponible\":false") || resultStr.includes("No hay")) {
      return "NO_AVAILABILITY";
    }
    return "SUCCESS";
  }

  // Default: éxito si no hay error
  return "SUCCESS";
}
