import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Las claves de los usuarios del panel.
 *
 * `scrypt` viene en Node y es de las funciones pensadas para esto: es lenta y
 * cara en memoria a proposito, de modo que probar claves en masa cuesta. Un
 * SHA a secas no sirve aca — se calcula tan rapido que una lista de claves
 * comunes se prueba entera en segundos.
 *
 * No hace falta ninguna dependencia nueva.
 */
type OpcionesScrypt = { N: number; r: number; p: number; maxmem: number };
/**
 * `promisify` no conserva la sobrecarga de `scrypt` que recibe opciones, asi
 * que se declara aqui. Sin esto no hay forma de subirle el coste.
 */
const scryptAsync = promisify(scrypt) as (
  clave: string,
  sal: Buffer,
  largo: number,
  opciones: OpcionesScrypt,
) => Promise<Buffer>;

/** Coste de scrypt. N debe ser potencia de 2; 2^15 tarda ~100 ms por clave. */
const N = 32_768;
const R = 8;
const P = 1;
const LARGO_SAL = 16;
const LARGO_CLAVE = 32;

/** El largo minimo lo decide quien crea el usuario, no esta funcion. */
export const LARGO_MINIMO_CLAVE = 12;

/**
 * `scrypt:N:r:p:sal:hash`, todo en una columna de texto.
 *
 * Los parametros viajan con el hash a proposito: el dia que haya que subir el
 * coste, las claves viejas se siguen verificando con el suyo en vez de dejar
 * a todo el mundo afuera.
 */
export async function hashDeClave(clave: string): Promise<string> {
  const sal = randomBytes(LARGO_SAL);
  // scrypt pide memoria explicita cuando N sube del valor por defecto.
  const derivada = await scryptAsync(clave.normalize('NFKC'), sal, LARGO_CLAVE, {
    N, r: R, p: P, maxmem: 128 * N * R * 2,
  });

  return ['scrypt', N, R, P, sal.toString('base64'), derivada.toString('base64')].join(':');
}

/**
 * Compara en tiempo constante. Un hash ausente o mal formado devuelve `false`
 * en vez de reventar: un usuario sin clave todavia no puede entrar, y eso no
 * es un error del sistema.
 */
export async function verificarClave(clave: string, guardado: string | undefined): Promise<boolean> {
  if (!clave || !guardado) return false;

  const partes = guardado.split(':');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return false;

  const n = Number(partes[1]);
  const r = Number(partes[2]);
  const p = Number(partes[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Un N absurdo en la base colgaria el proceso; se rechaza en vez de obedecer.
  if (n < 1024 || n > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16) return false;

  let esperado: Buffer;
  try {
    esperado = Buffer.from(partes[5], 'base64');
  } catch {
    return false;
  }
  if (esperado.length === 0) return false;

  try {
    const sal = Buffer.from(partes[4], 'base64');
    const derivada = await scryptAsync(clave.normalize('NFKC'), sal, esperado.length, {
      N: n, r, p, maxmem: 128 * n * r * 2,
    });
    return timingSafeEqual(derivada, esperado);
  } catch {
    return false;
  }
}
