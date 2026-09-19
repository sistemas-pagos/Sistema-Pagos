import { type Usuario, puedeConciliar } from '@/src/storage/usuarios';

/**
 * Que hacer con un mensaje que podria ser parte de una conciliacion.
 *
 * Decide solo el camino; no descarga nada ni escribe nada. Se prueba sin base
 * y sin red porque es donde estan las reglas que importan: quien puede mandar
 * un extracto y que cuenta como un "SI".
 */

export type AccionConciliacion =
  | { accion: 'confirmar' }
  | { accion: 'cancelar' }
  | { accion: 'no_entendido'; respuesta: string }
  /** Nada que ver con la conciliacion: sigue por el camino de siempre. */
  | { accion: 'nada' };

/** Sin tildes, sin espacios y sin el punto final que deja el teclado. */
function respuestaCorta(texto: string): string {
  return texto
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim().toUpperCase()
    .replace(/[.!¡¿?]+$/, '')
    .trim();
}

const PEDIR_SI = 'Para aplicar el extracto respondé SI. Para descartarlo, NO.';

/**
 * Que hacer con un **texto** de alguien que podria estar confirmando un
 * extracto.
 *
 * De los documentos no decide nada: de eso decide el parser, que es el unico
 * que sabe de verdad si un archivo es un estado de cuenta. El nombre y el tipo
 * que declara WhatsApp los pone quien manda el archivo.
 */
export function decidirConciliacion(
  usuario: Usuario | undefined,
  texto: string,
  hayImportacionPendiente: boolean,
): AccionConciliacion {
  // Fallar cerrado: quien no esta en `usuarios` con rol de conciliar no llega
  // ni a que se mire su mensaje, y tampoco se entera de que existe el camino.
  if (!puedeConciliar(usuario)) return { accion: 'nada' };

  // Sin nada esperando confirmacion, un "SI" suelto no significa nada: el
  // tesorero tambien es vecino y escribe por otras cosas.
  if (!hayImportacionPendiente) return { accion: 'nada' };

  const respuesta = respuestaCorta(texto);
  if (respuesta === 'SI') return { accion: 'confirmar' };
  if (respuesta === 'NO') return { accion: 'cancelar' };
  return { accion: 'no_entendido', respuesta: PEDIR_SI };
}
