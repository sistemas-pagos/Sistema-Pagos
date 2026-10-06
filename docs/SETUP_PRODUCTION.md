# Configuración de producción

Este documento describe lo que debe existir fuera de GitHub. No contiene valores reales.

## 1. Turso (base de datos)

Turso es la única fuente de verdad del sistema (`docs/PLAN.md`, sección 1). La base es
nueva y exclusiva de este proyecto: no se comparte con ningún otro.

### 1.1 Crear la base

En [turso.tech](https://turso.tech), con la cuenta de la empresa:

1. **Create Database**, nombre `sistema-pagos`, región la más cercana a Honduras.
2. Copiar la **Database URL** (empieza con `libsql://`).
3. **Create Token** con `Expires: Never` y `Authorization Level: Read & Write`.
   Read & Write es obligatorio: las migraciones crean tablas y el sistema escribe pagos.
   El token se muestra una sola vez; si se pierde, se revoca y se crea otro.

Equivalente por terminal:

```bash
turso db create sistema-pagos
turso db show sistema-pagos --url      # PAGOS_TURSO_URL
turso db tokens create sistema-pagos   # PAGOS_TURSO_TOKEN
```

### 1.2 Guardar las credenciales en GitHub

En **Settings → Environments** del repositorio, crear un Environment llamado
`pagos-produccion` (exacto; el workflow lo busca por ese nombre) con dos
**Environment secrets**:

- `PAGOS_TURSO_URL`
- `PAGOS_TURSO_TOKEN`

Activar **Required reviewers** en ese Environment. Es lo que impide que una migración
toque la base real sin que una persona la apruebe.

Estas credenciales nunca van al código, a `.env` versionado, a los logs ni a las
fixtures. Si se filtran: revocar el token en Turso, crear otro y actualizar el secreto.
No hay que tocar código.

### 1.3 Aplicar las migraciones

Las migraciones viven en `migrations/NNN_*.sql` y las aplica **solo** el workflow manual
`migraciones`:

1. Actions → **Migraciones** → **Run workflow** → rama `main`.
2. Aprobar cuando el Environment lo pida.
3. El log debe decir `Migraciones aplicadas: N` con los nombres de archivo. No imprime
   filas, ni la URL de la base, ni el token.

Una segunda corrida sin migraciones nuevas debe decir `Sin migraciones pendientes.`

Una migración aplicada es **inmutable**: el script guarda su `sha256` en
`schema_migrations` y rechaza la corrida si el archivo cambió. Para modificar el esquema
se agrega un archivo nuevo, nunca se edita uno ya aplicado.

## 2. Nada de Google

No hace falta ninguna cuenta de Google: ni proyecto en Google Cloud, ni cuenta de servicio, ni
hoja de cálculo, ni Drive. Turso es la única base y el panel muestra lo que antes iba a mostrar
una hoja.

Esto importa al montar producción porque **es una credencial menos que existe y que habría que
cuidar**. No es un pendiente: Sheets quedó descartada en todo punto (`docs/PLAN.md`, sección 1),
así que no hay nada de Google por configurar ni ahora ni después.

## 3. Retención de comprobantes

Las imágenes recibidas por WhatsApp se usan únicamente durante la solicitud:

1. descarga server-side;
2. validación de tamaño, MIME y magic bytes;
3. cálculo de SHA-256;
4. OCR y parser;
5. registro de datos estructurados;
6. descarte de los bytes de la imagen.

No crear carpeta de Drive, Blob, S3 u otro archivo histórico mientras el cliente mantenga esta decisión.

Si posteriormente el cliente autoriza retención, debe diseñarse como una función separada con política de acceso y retención explícita; no debe activarse silenciosamente.

## 4. Meta / WhatsApp Cloud API

Configurar una aplicación de Meta y un número autorizado para WhatsApp Cloud API.

Variables:

- `WHATSAPP_VERIFY_TOKEN` — valor aleatorio generado para verificar el webhook;
- `WHATSAPP_ACCESS_TOKEN` — token server-side;
- `WHATSAPP_PHONE_NUMBER_ID`;
- `META_APP_SECRET`;
- `WHATSAPP_GRAPH_VERSION` — versión configurada para el proyecto.

Webhook de producción:

```text
https://<dominio>/api/whatsapp/webhook
```

Suscribir únicamente los eventos necesarios.

El número que envía el comprobante se utiliza para responder y para correlacionar temporalmente una respuesta pendiente. **Nunca se usa para inferir Etapa/Bloque/Casa.**

## 5. Vercel

Crear un proyecto con:

- repositorio: `sistemas-pagos/Sistema-Pagos`;
- Root Directory: la raíz del repositorio;
- framework: Next.js;
- Node.js 22.

Separar variables de Preview y Production. Los secretos de producción no deben estar disponibles en previews públicas salvo necesidad explícita.

Variables de autenticación:

- `PAGOS_BANCO_DEPOSITO` y `PAGOS_CUENTA_DEPOSITO` — el banco y el número de cuenta donde el
  residente deposita, más `EXPECTED_BENEFICIARY` con el nombre del titular. No son secretos
  —son justamente lo que hay que repartir— pero van en variables y no en el código, porque el
  repositorio es público y la cuenta puede cambiar. Si faltan, el mensaje de bienvenida sale
  igual, sin esas líneas.
- `ADMIN_ACCESS_KEY` — clave larga y aleatoria;
- `AUTH_SESSION_SECRET` — secreto aleatorio independiente.

`ADMIN_ACCESS_KEY` es la clave compartida anterior a los usuarios por persona: existe **solo
mientras la variable esté puesta**. Cuando el login por usuario ya funcione, borrarla de Vercel
cierra ese camino sin tocar código ni desplegar.

La base y el envío de recibos:

- `PAGOS_TURSO_URL`, `PAGOS_TURSO_TOKEN` — las mismas de la sección 1;
- `WHATSAPP_TEMPLATE_RECIBO` y `WHATSAPP_TEMPLATE_IDIOMA` — el nombre y el idioma **exactos** de
  la plantilla aprobada en Meta. Si no coinciden, Meta rechaza el envío con 404 y el recibo queda
  en la cola de no entregados.

Beneficiario y cuenta destino, **obligatorios en producción** (invariante 4):

- `EXPECTED_BENEFICIARY`;
- `EXPECTED_ACCOUNT_LAST4`.

Sin ellos el sistema no puede distinguir un depósito a la cuenta del condominio de uno a
cualquier otra cuenta, así que los comprobantes quedan en error en vez de aceptarse a ciegas.

`EXPECTED_PAYMENT_AMOUNT=150` es solo el respaldo mientras la tabla `cuotas` no tenga fila: la
cuota de verdad vive en la base con su `vigente_desde`, para que un mes viejo cueste lo que
costaba entonces.

Configurar `APP_MODE=production` únicamente en producción. Mantener previews públicas en `demo`
cuando no necesiten datos reales.

## 6. Viviendas

El padrón se carga desde el panel (`/admin/homes`) y vive en la tabla `viviendas` de Turso.

Campos mínimos por vivienda: **etapa, bloque y casa** —que son su identidad— y la **fecha de
alta**, que es desde cuándo se le puede cobrar. Para el arranque, `fecha_alta = 2026-09-01`.

Etapa, bloque y casa son texto y admiten letras. El código compacto (`E1B4C18`) se deriva de los
tres y es único.

**No hay campo de teléfono en el padrón.** El teléfono se guarda con el pago, para mandar el
recibo, y nunca sirve para deducir la vivienda (invariante 1).

Sin padrón cargado no se puede cobrar nada: un pago necesita una casa a la cual asignarse.

## 7. Saldo inicial y mes base

**Septiembre de 2026 es el primer mes de servicio.** Quien no pague septiembre queda moroso, y
antes de septiembre el sistema no asigna ningún mes.

La deuda anterior **no se carga como meses ni como pagos**. Entra una sola vez por vivienda como
un `ajustes` de tipo `SALDO_INICIAL`, que se importa desde `/admin/saldos`. Cargarla como meses
obligaría a inventar en qué mes cayó cada lempira de una deuda que nadie llevó al día.

La prórroga del mes base —hasta el 14 de octubre de 2026— es **única** y se guarda como dato del
período. No se repite en los meses siguientes y no va escrita en el código: una excepción de
calendario incrustada en el código es justamente lo que la fase 3 vino a eliminar.

La regla especial de agosto de 2026 que aparecía en versiones anteriores de esta guía (depósitos
del 1 al 14 asignados a julio) **ya no existe** y no debe reintroducirse.

## 8. Verificación bancaria

El sistema **no necesita acceso a la banca en línea**, ni ahora ni después.

El camino normal es el extracto: el tesorero descarga el CSV de BAC y lo manda por WhatsApp desde
un número que esté en `usuarios` con rol ADMIN o TESORERO. El sistema importa los movimientos sin
duplicarlos, responde un resumen y aplica cuando el tesorero confirma; la confirmación expira
(`PAGOS_CONFIRMACION_MINUTOS`, dos horas por defecto) para que un "SI" de mañana no aplique un
extracto contra pagos que ya cambiaron.

También se puede verificar desde el panel después de revisar el movimiento por cuenta propia. En
los dos casos, un monto que no es múltiplo de la cuota, un conflicto de mes o un movimiento ya
usado permanecen en revisión: primero se resuelve la excepción, el botón de verificar no la borra.

Cada pago verificado guarda su `movimiento_id`, que es UNIQUE. Un movimiento del banco no puede
verificar dos pagos, ni en la misma corrida ni en otra.

No almacenar usuario, contraseña, PIN, token OTP ni códigos de BAC en Vercel, GitHub, el navegador
ni en ningún archivo del repositorio.

## 9. Validación antes de operar

- webhook challenge funciona;
- firma inválida retorna 401;
- archivo no imagen se rechaza;
- comprobante BAC sintético/de prueba controlada se procesa;
- la imagen no queda archivada después del procesamiento;
- el pago no guarda `media_id` ni ninguna referencia que permita abrir la imagen;
- retry del mismo `message_id` no duplica;
- comprobante con E/B/C completos valida la vivienda;
- comprobante que omite cualquiera de Etapa/Bloque/Casa pide los tres datos;
- respuesta `E1 B4 C18` asigna la vivienda sin repetir OCR;
- el teléfono remitente no asigna vivienda;
- monto igual a la cuota vigente sigue a verificación bancaria;
- monto que no es múltiplo de la cuota pasa a revisión y no puede verificarse por el atajo manual;
- depósito de octubre con septiembre sin verificar se mantiene en septiembre;
- depósito de octubre con septiembre ya `VERIFICADO` se aplica a octubre;
- nada se asigna a un mes anterior a septiembre de 2026;
- una vivienda sólo aparece pagada después de `VERIFICADO`;
- referencia repetida pasa a revisión y no se descarta automáticamente;
- archivo exacto reenviado no incrementa recaudación gracias al hash persistido;
- panel permite verificación bancaria manual sólo para pagos elegibles;
- un conflicto de período no puede verificarse hasta corregirse;
- un `bank_movement_id` ya usado no verifica otro pago;
- panel requiere login, y el cobrador entra a `/cobros` pero no al panel;
- un cobro en efectivo emite recibo y su número queda anotado en el talonario;
- el cobrador no puede cerrar su propia caja;
- `VERIFICADO` sólo aparece tras una confirmación bancaria explícita, o tras el cierre de caja de
  un cobro en efectivo.
