import { z } from 'zod';

const imageSchema = z.object({
  id: z.string().min(1),
  mime_type: z.string().optional(),
}).passthrough();

const documentSchema = z.object({
  id: z.string().min(1),
  mime_type: z.string().optional(),
  filename: z.string().optional(),
}).passthrough();

const messageSchema = z.object({
  from: z.string().min(4).max(32),
  id: z.string().min(1).max(256),
  timestamp: z.string().optional(),
  type: z.enum(['image', 'document', 'text']).or(z.string()),
  image: imageSchema.optional(),
  document: documentSchema.optional(),
  text: z.object({ body: z.string().max(2000) }).optional(),
}).passthrough();

const webhookSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(z.object({
    changes: z.array(z.object({
      value: z.object({
        messages: z.array(messageSchema).max(50).optional(),
      }).passthrough(),
    }).passthrough()).max(50),
  }).passthrough()).max(50),
}).passthrough();

export type IncomingWhatsAppMessage =
  | { kind: 'image'; messageId: string; phone: string; mediaId: string; declaredMime?: string }
  | { kind: 'document'; messageId: string; phone: string; mediaId: string; declaredMime?: string; filename?: string }
  | { kind: 'text'; messageId: string; phone: string; body: string }
  | { kind: 'other'; messageId: string; phone: string };

export function extractIncomingMessages(payload: unknown): IncomingWhatsAppMessage[] {
  const parsed = webhookSchema.parse(payload);
  const output: IncomingWhatsAppMessage[] = [];

  for (const entry of parsed.entry) {
    for (const change of entry.changes) {
      for (const message of change.value.messages ?? []) {
        if (message.type === 'image' && message.image) {
          output.push({ kind: 'image', messageId: message.id, phone: message.from, mediaId: message.image.id, declaredMime: message.image.mime_type });
        } else if (message.type === 'document' && message.document) {
          output.push({ kind: 'document', messageId: message.id, phone: message.from, mediaId: message.document.id, declaredMime: message.document.mime_type, filename: message.document.filename });
        } else if (message.type === 'text' && message.text) {
          output.push({ kind: 'text', messageId: message.id, phone: message.from, body: message.text.body });
        } else {
          output.push({ kind: 'other', messageId: message.id, phone: message.from });
        }
      }
    }
  }

  return output;
}
