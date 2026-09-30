# Arquitectura

## Principios

1. **Recibido no significa verificado.** OCR identifica una transacción declarada; una revisión bancaria humana o futura conciliación bancaria confirma el dinero.
2. **Pagado significa verificado.** Un comprobante pendiente o en revisión no marca una vivienda como pagada ni hace avanzar por sí solo el histórico de meses.
3. **Fail closed.** Firma inválida, MIME inconsistente, vivienda desconocida, monto inesperado o datos conflictivos no se aceptan silenciosamente.
4. **Minimización de datos.** Las imágenes de comprobantes se procesan sólo en memoria durante la solicitud y no se archivan; la base conserva únicamente datos estructurados, trazabilidad y hash.
5. **Demo y producción separados.** La demo usa fixtures sintéticos; producción exige variables de entorno y recursos privados.
6. **Parser por banco.** La lógica bancaria vive detrás de `ReceiptParser`.
7. **Excepciones visibles.** Sin identificar, duplicados y revisión tienen estados y bandejas propias.
8. **Vivienda estable.** Sólo `Etapa + Bloque + Casa` identifica una vivienda. Ni teléfono ni depositante participan en esa identidad.

## Componentes

```text
WhatsApp Cloud API
        │
        ▼
/api/whatsapp/webhook
  ├─ valida challenge / HMAC
  ├─ valida payload
  └─ descarga media autorizada temporalmente
        │
        ▼
Receipt file guard
  ├─ tamaño
  ├─ MIME declarado
  └─ magic bytes + SHA-256
        │
        ▼
Sharp → Tesseract.js
        │
        ▼
ReceiptParser registry
        │
        └─ bac/
        │
        ▼
Payment processor
  ├─ Etapa/Bloque/Casa por detalle
  ├─ pregunta E/B/C si falta cualquiera
  ├─ contexto temporal por remitente WhatsApp
  ├─ cuota vigente del mes; diferencias → revisión
  ├─ reglas de mes desde septiembre 2026 basadas en pagos verificados
  ├─ duplicados / conflictos / revisión
  ├─ validación beneficiario/cuenta
  ├─ persiste hash + datos extraídos
  └─ descarta bytes de imagen al finalizar
        │
        ▼
Turso (fuente de verdad)
        │
        ├─ panel administrativo
        │    ├─ corregir E/B/C o mes
        │    ├─ revisar excepciones y notas del cobrador
        │    ├─ cerrar caja del cobrador
        │    └─ verificar tras revisar banco
        ├─ pantalla de cobros (efectivo, desde el teléfono)
        └─ conciliación por CSV del banco
             └─ un movimiento verifica un solo pago (UNIQUE)
```

## Idempotencia y posibles duplicados

Se aplican varias capas:

- `message_id` de WhatsApp identifica retries técnicos y se ignora silenciosamente;
- SHA-256 detecta el mismo archivo exacto reenviado aun cuando la imagen original ya no esté guardada;
- el mismo archivo desde otro remitente se manda a revisión;
- `banco + referencia` es una señal de correlación/riesgo, **no** se considera un identificador global único;
- referencia repetida con otra vivienda, monto o fecha incompatible produce revisión/conflicto;
- `banco + vivienda + monto + fecha` es señal débil y sólo manda a revisión;
- un monto que no es múltiplo de la cuota vigente se manda a revisión aunque el resto del comprobante parezca válido;
- el dashboard sólo excluye registros explícitamente marcados `DUPLICADO` o `RECHAZADO` de los montos recibidos, pero una vivienda sólo se considera pagada cuando existe un `VERIFICADO`.

Las capas de arriba son heurísticas y pueden equivocarse hacia revisión. Lo que **no** depende de una heurística vive en el esquema: `pagos.movimiento_id` es UNIQUE, así que un movimiento del banco no puede verificar dos pagos; `pago_meses` tiene un índice único parcial que impide que dos pagos activos tomen el mismo mes de la misma vivienda; `mensajes.message_id` es la clave primaria. Una restricción de la base no se puede olvidar en un camino de código nuevo.

## Resolución de vivienda

Único orden válido:

1. buscar `Etapa + Bloque + Casa` completos en el comprobante;
2. validar que esa combinación exista y esté activa en la base maestra;
3. si falta cualquiera de los tres, preguntar por WhatsApp: `E1 B4 C18`;
4. usar el número remitente sólo para relacionar esa respuesta con el comprobante pendiente;
5. actualizar el mismo pago sin volver a ejecutar OCR.

No existe resolución teléfono → vivienda. Si ya existe un comprobante pendiente de E/B/C para el mismo remitente, un segundo comprobante sin vivienda no crea otro contexto ambiguo: queda `EN_REVISION`.

## Mes de servicio

La fecha del depósito y el mes pagado son campos distintos.

- **Septiembre de 2026 es el primer mes de servicio** (`BASE_PERIOD`). No se asigna nada antes,
  ni antes del alta de la vivienda.
- La deuda anterior a septiembre no entra como meses ni como pagos: entra una sola vez como
  `ajustes` de tipo `SALDO_INICIAL`. Por eso **ya no existe la regla especial de agosto** que
  mapeaba los depósitos del 1–14 a julio: una excepción de calendario incrustada en el código es
  lo que la fase 3 vino a eliminar, y las prórrogas se guardan como dato del período.
- Se asigna el mes más antiguo desde el alta que no tenga un pago `VERIFICADO` **ni esté
  reservado por uno pendiente**. `NO_ENCONTRADO`, `RECHAZADO` y `ANULADO` liberan el mes.
- Un comprobante `PENDIENTE_VERIFICACION` o `EN_REVISION` no hace avanzar el mes, pero sí lo
  reserva: el índice único parcial de `pago_meses` impide que un segundo pago tome el mismo mes
  mientras el primero siga vivo.
- Nunca se asigna un mes futuro. Si todo está pagado hasta la fecha del depósito, el caso queda
  visible para revisión en vez de adelantarse en silencio.

## Cuota y monto

La cuota vigente vive en `cuotas` con su `vigente_desde`, así que **un mes viejo cuesta lo que
costaba entonces**: si agosto valía L150 y septiembre L200, dos meses son L350 y no dos veces la
cuota de hoy. `EXPECTED_PAYMENT_AMOUNT` es solo el respaldo mientras esa tabla no tenga fila.

- monto igual a la cuota → puede continuar a `PENDIENTE_VERIFICACION` si no existe otra excepción;
- múltiplo exacto de la cuota → se reparte en meses atrasados, nunca futuros;
- cualquier otro monto → `EN_REVISION`.

Una comprobación humana de que el movimiento existe en BAC no elimina automáticamente una
excepción de monto. Esto evita convertir por accidente un abono parcial en una cuota normal
mientras no haya una regla explícita para esos casos (`docs/PLAN.md`, sección 7).

Con efectivo el problema no existe: el cobrador marca meses y el total sale de la cuota de cada
uno, así que un monto que no es múltiplo de la cuota no se puede registrar.

## Archivos de comprobantes

Producción **no conserva** las imágenes recibidas. El backend descarga la media de WhatsApp, valida tipo/tamaño, calcula el hash, ejecuta OCR y utiliza los bytes únicamente durante esa solicitud.

Después del procesamiento no se guarda:

- la imagen;
- `media_id` como dato del pago;
- un `receipt_file_id`;
- una URL o copia en Drive/S3/Blob.

Sí se conserva `file_hash` (SHA-256) porque permite reconocer un reenvío exacto sin almacenar el documento bancario. Si un caso requiere una revisión visual futura, el encargado tendría que solicitar que el comprobante sea reenviado; la verificación financiera de todas formas se hace contra el movimiento real del banco.

## Autenticación

Cada persona entra con su usuario y su rol (`ADMIN`, `TESORERO`, `COBRADOR`):

- clave por persona en `usuarios.clave_hash`, con `scrypt` y los parámetros del coste guardados
  junto al hash;
- la verificación corre incluso cuando el usuario no existe, contra un hash señuelo: sin eso, un
  usuario inexistente respondería al instante y uno real tardaría los ~100 ms de scrypt, y esa
  diferencia se mide desde afuera;
- cookie de sesión firmada HMAC que lleva **quién** y **con qué rol**; editar el rol en la cookie
  rompe la firma;
- `HttpOnly`, `SameSite=Strict`, `Secure` en producción;
- comprobación de mismo origen para acciones mutables, que acepta `Origin` o, si no viene,
  `Referer`, y rechaza el `Origin: null` explícito.

`ADMIN_ACCESS_KEY` es la clave compartida anterior y sigue abriendo el panel mientras la variable
esté configurada: al borrarla, ese camino desaparece sin tocar código. La sesión que crea se
anota como `panel` y no como una persona, así que no puede recibir una caja —el esquema exige
`cobrador_id <> tesorero_id`.

La demo pública no reutiliza datos de producción.

## Verificación y conciliación

La verificación normal viene del **extracto del banco**: el tesorero manda el CSV por WhatsApp
desde un número que está en `usuarios` con rol ADMIN o TESORERO. El sistema importa los
movimientos —`movimientos_banco.huella` es UNIQUE, así que reimportar el mismo archivo no los
duplica—, manda un resumen (verificados, depósitos sin comprobante, comprobantes sin depósito) y
aplica al recibir la confirmación, que expira. La aplicación no necesita ni debe almacenar
usuario, contraseña, PIN ni códigos de BAC.

Cada pago verificado guarda su `movimiento_id`, que es UNIQUE: un movimiento no puede verificar
dos pagos, ni en la misma corrida ni en otra. Una coincidencia inconsistente no se fuerza, va a
revisión.

El encargado también puede verificar desde el panel después de revisar el movimiento por su
cuenta, y ese camino registra quién lo hizo en `eventos`.

La fuente de movimientos se mantiene detrás de `src/bank/` para incorporar otro formato de
archivo, una notificación oficial o una API autorizada sin tocar la lógica de conciliación.
