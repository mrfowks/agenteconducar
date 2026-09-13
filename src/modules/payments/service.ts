import { TicketReason } from "@prisma/client";

export const PAYMENT_METHODS_INFO = `Métodos de pago en Conducar:
• Efectivo
• Yape
• Plin
• Tarjeta de débito o crédito (con recargo del 5%)

Para reservar una práctica o simulacro debes realizar el pago previamente: se te comparte un código QR, pagas por Yape o Plin y envías el comprobante por este chat.`;

/** Detecta intenciones que SIEMPRE se derivan a un asesor humano. */
export function detectEscalationTrigger(text: string): TicketReason | null {
  const t = text.toLowerCase();

  const onlinePayment =
    /\b(pago|pagar|pagando)\s*(en\s*)?(linea|l[ií]nea|online)\b|\bpagar\s*por\s*(internet|web|pagina|p[aá]gina)\b|\btarjeta\s*online\b|\bpaypal\b/.test(t);
  if (onlinePayment) return "PAYMENT";

  const cancel = /\bcancelar\b|\bcancelacion\b|\bcancelaci[oó]n\b|\banular\b/.test(t);
  if (cancel) return "CANCEL";

  const reprogram = /\breprogram\w*\b|\breagendar\b|\bcambiar\s*(la|de)?\s*(fecha|hora|dia|d[ií]a)\b/.test(t);
  if (reprogram) return "REPROGRAM";

  const noShow = /\bno\s+(asistir|asistire|ir[eé])\b|\binasistencia\b|\bno\s+(pude|puedo)\s+(asistir|ir)\b/.test(t);
  if (noShow) return "NO_SHOW";

  // El usuario pide hablar con una persona: siempre a un asesor humano.
  const human =
    /\bhablar\s+con\s+(un(?:a)?\s+)?(asesor|agente|persona|humano|alguien)\b|\bhablar\s+con\s+(un(?:a)?\s+)?ser\b|\batender\w*\s*un(?:a)?\s+asesor\b/.test(t);
  if (human) return "NO_SOLUTION";

  // NOTA: "más prácticas", "mejorar paquete" y "requisitos de licencia/categoría" NO se escalan aquí:
  // el agente los resuelve con consultar_paquetes, consultar_informacion_licencia y consultar_recategorizacion.

  return null;
}
