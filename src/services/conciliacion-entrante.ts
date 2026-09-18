import { type Usuario, puedeConciliar } from '@/src/storage/usuarios';

/**
 * Que hacer con un mensaje que podria ser parte de una conciliacion.
 *
 * Decide solo el camino; no descarga nada ni escribe nada. Se prueba sin base
 * y sin red porque es donde estan las reglas que importan: quien puede mandar
 * un extracto y que cuenta como un "SI".
 */

export type AccionConciliacion =
  /** Bajar el archivo e intentar leerlo como extracto. */
  | { accion: 'extracto' }
  | { accion: 'formato_no_soportado'; respuesta: string }
  | { accion: 'confirmar' }
  | { accion: 'cancelar' }
  | { accion: 'no_entendido'; respuesta: string }
  /** Nada que ver con la conciliacion: sigue por el camino de siempre. */
  | { accion: 'nada' };

export interface MensajeEntrante {
  kind: 'image' | 'document' | 'text' | 'other';
  filename?: string;
  declaredMime?: string;
  body?: string;
}

function extension(filename: string | undefined): string {
  const encontrado = /\.([a-z0-9]+)$/i.exec(filename?.trim() ?? '');
  return encontrado ? encontrado[1].toLowerCase() : '';
}

const HOJAS_DE_CALCULO = new Set(['xlsx', 'xls', 'xlsm', 'ods']);

/**
 * El nombre y el tipo que declara WhatsApp son una pista, no una garantia: los
 * pone quien manda el archivo. Aca solo deciden a que intento va; si el archivo
 * no es un extracto, quien lo dice es el parser.
 */
function pareceExtracto(mensaje: MensajeEntrante): boolean {
  const ext = extension(mensaje.filename);
  if (ext === 'csv' || ext === 'txt') return true;
  if (ext) return false;
  return /csv|comma-separated/i.test(mensaje.declaredMime ?? '');
}

/** Sin tildes, sin espacios y sin el punto final que deja el teclado. */
function respuestaCorta(texto: string): string {
  return texto
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim().toUpperCase()
    .replace(/[.!¡¿?]+$/, '')
    .trim();
}

const PEDIR_CSV = 'Ese archivo no lo puedo leer. Descargá el estado de cuenta del BAC en formato CSV y mandámelo así.';
const PEDIR_SI = 'Para aplicar el extracto respondé SI. Para descartarlo, NO.';

export function decidirConciliacion(
  usuario: Usuario | undefined,
  mensaje: MensajeEntrante,
  hayImportacionPendiente: boolean,
): AccionConciliacion {
  // Fallar cerrado: quien no esta en `usuarios` con rol de conciliar ni siquiera
  // llega a que se mire el archivo. Y no se le dice que existe este camino.
  if (!puedeConciliar(usuario)) return { accion: 'nada' };

  if (mensaje.kind === 'document') {
    if (pareceExtracto(mensaje)) return { accion: 'extracto' };
    if (HOJAS_DE_CALCULO.has(extension(mensaje.filename))) {
      return { accion: 'formato_no_soportado', respuesta: PEDIR_CSV };
    }
    // Un PDF puede ser el comprobante del tesorero como vecino.
    return { accion: 'nada' };
  }

  // Sin nada esperando confirmacion, un "SI" suelto no significa nada: el
  // tesorero tambien es vecino y escribe por otras cosas.
  if (mensaje.kind === 'text' && hayImportacionPendiente) {
    const respuesta = respuestaCorta(mensaje.body ?? '');
    if (respuesta === 'SI') return { accion: 'confirmar' };
    if (respuesta === 'NO') return { accion: 'cancelar' };
    return { accion: 'no_entendido', respuesta: PEDIR_SI };
  }

  return { accion: 'nada' };
}
