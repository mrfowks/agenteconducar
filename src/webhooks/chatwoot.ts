import express, { Request, Response } from 'express';
import { z } from 'zod';

// Interfaces para los eventos de Chatwoot
interface ChatwootMessage {
  id: number;
  text: string;
  direction: 'incoming' | 'outgoing';
  created_at: string;
  updated_at: string;
  contact: {
    id: number;
    name: string | null;
    phone: string;
    email: string | null;
  };
  metadata: Record<string, any>;
}

interface ChatwootConversation {
  id: number;
  subject: string | null;
  last_message_at: string;
  updated_at: string;
  contact: {
    id: number;
    name: string | null;
    phone: string;
    email: string | null;
  };
  status: string;
}

// Normaliza números de teléfono de Chatwoot
function normalizeChatwootPhone(phone: string): string {
  if (!phone) return '';
  return phone
    .replace(/\D/g, '')
    .replace(/^(52)?(?:\s*)?1?/, '')
    .replace(/^52/, '')
    .replace(/^(?:\s*)?1/, '')
    .replace(/^\+/, '')
    .trim();
}

// Procesa un evento de Chatwoot y lo rote al sistema Conducar
function processChatwootEvent(event: any) {
  const { type, data } = event;

  if (type === 'message') {
    const message: ChatwootMessage = data?.attributes?.message;
    if (!message) return null;

    const phone = normalizeChatwootPhone(message.contact?.phone || '');
    const text = message.text;

    // Aquí se integra con el sistema Conducar
    // Ejemplo: crear o actualizar contacto, enviar mensaje, etc.
    return {
      type: 'chatwoot_message',
      phone,
      text,
      source: 'chatwoot',
      messageId: message.id,
    };
  }

  if (type === 'conversation_update') {
    const conversation: ChatwootConversation = data?.attributes?.conversation;
    if (!conversation) return null;

    const phone = normalizeChatwootPhone(conversation.contact?.phone || '');

    return {
      type: 'chatwoot_conversation_update',
      phone,
      status: conversation.status,
      source: 'chatwoot',
      conversationId: conversation.id,
    };
  }

  return null;
}

// Valida la firma de Chatwoot (opcional)
function validateChatwootSignature(req: Request): boolean {
  const signature = req.get('X-Chatwoot-Signature');
  const secret = process.env.CHATWOOT_WEBHOOK_SECRET;

  if (!signature || !secret) return true; // Sin validación si no hay secreto

  // Implementar validación HMAC-SHA256
  // return crypto.createHmac('sha256', secret).update(reqrawbody).digest('hex') === signature;
  return true;
}

// Endpoint POST /webhooks/chatwoot
export const chatwootHandler = async (req: Request, res: Response) => {
  try {
    // Validar firma si está configurado
    const valid = validateChatwootSignature(req);
    if (!valid) {
      return res.status(401).json({ error: 'Firma inválida' });
    }

    const event = req.body;

    if (!event || !event.type) {
      return res.status(400).json({ error: 'Evento inválido' });
    }

    // Procesar el evento y rote al sistema Conducar
    const processed = processChatwootEvent(event);

    if (processed) {
      // Aquí se integraría con el sistema Conducar
      // Ejemplo: await conducarSystem.handle(processed);
    }

    // Responder 200 rápidamente
    res.status(200).json({ status: 'processed' });
  } catch (error) {
    console.error('Error processing Chatwoot webhook:', error);
    // Responder 200 incluso ante errores para que Chatwoot no vuelva a reenviar
    res.status(200).json({ status: 'ok', error: 'handled' });
  }
};

const router = express.Router();
router.post('/', chatwootHandler);

export default router;