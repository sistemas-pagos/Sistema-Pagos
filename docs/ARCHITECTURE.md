# Arquitectura

## Principios

1. **Recibido no significa verificado.** OCR identifica una transacción declarada; una revisión bancaria humana o futura conciliación bancaria confirma el dinero.
2. **Pagado significa verificado.** Un comprobante pendiente o en revisión no marca una vivienda como pagada ni hace avanzar por sí solo el histórico de meses.
3. **Fail closed.** Firma inválida, MIME inconsistente, vivienda desconocida, monto inesperado o datos conflictivos no se aceptan silenciosamente.
4. **Minimización de datos.** Las imágenes de comprobantes se procesan sólo en memoria durante la solicitud y no se archivan; Google Sheets conserva únicamente datos estructurados, trazabilidad y hash.
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
  ├─ cuota esperada L150; diferencias → revisión
  ├─ reglas de mes desde agosto 2026 basadas en pagos verificados
  ├─ duplicados / conflictos / revisión
  ├─ validación beneficiario/cuenta
  ├─ persiste hash + datos extraídos
  └─ descarta bytes de imagen al finalizar
        │
        ▼
Google Sheets privado
        │
        ├─ panel administrativo
        │    ├─ corregir E/B/C o mes
        │    ├─ revisar excepciones
        │    └─ verificar tras revisar banco
        └─ futura conciliación bancaria
             └─ movimiento bancario estable no reutilizable
```

## Idempotencia y posibles duplicados

Se aplican varias capas:

- `message_id` de WhatsApp identifica retries técnicos y se ignora silenciosamente;
- SHA-256 detecta el mismo archivo exacto reenviado aun cuando la imagen original ya no esté guardada;
- el mismo archivo desde otro remitente se manda a revisión;
- `banco + referencia` es una señal de correlación/riesgo, **no** se considera un identificador global único;
- referencia repetida con otra vivienda, monto o fecha incompatible produce revisión/conflicto;
- `banco + vivienda + monto + fecha` es señal débil y sólo manda a revisión;
- un monto diferente de L150 se manda a revisión aunque el resto del comprobante parezca válido;
- el dashboard sólo excluye registros explícitamente marcados `DUPLICADO` o `RECHAZADO` de los montos recibidos, pero una vivienda sólo se considera pagada cuando existe un `VERIFICADO`.

Google Sheets no ofrece una restricción UNIQUE ni transacciones ACID. El MVP evita presentarse como exactly-once a nivel de almacenamiento. Para alto volumen se recomienda introducir un datastore transaccional como fuente primaria y mantener Sheets como salida operativa.

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

- Agosto 2026 es la base histórica.
- 01–14 agosto → julio.
- 15–31 agosto → agosto.
- Desde septiembre se asigna el primer mes pendiente a partir de agosto usando sólo meses que ya están `VERIFICADO` como pagados.
- Un comprobante `PENDIENTE_VERIFICACION` o `EN_REVISION` no hace avanzar el mes. Si llega otro recibo para la misma vivienda, se asigna al mismo primer mes pendiente y el conflicto queda visible para revisión.
- Si todos los meses hasta la fecha del depósito ya están verificados, el sistema no adelanta silenciosamente a un mes futuro; mantiene el mes del depósito y expone el conflicto para revisión/corrección.

## Cuota y monto

La cuota esperada del MVP es L150.00 (`EXPECTED_PAYMENT_AMOUNT=150`). El monto extraído del banco se conserva sin modificar.

- L150.00 → puede continuar a `PENDIENTE_VERIFICACION` si no existe otra excepción.
- menor a L150 → `EN_REVISION` (`amount_below_expected`).
- mayor a L150 → `EN_REVISION` (`amount_above_expected`).

Una comprobación humana de que el movimiento existe en BAC no elimina automáticamente una excepción de monto. Esto evita convertir por accidente un abono parcial o un monto múltiple en una cuota normal hasta definir reglas para esos casos.

## Archivos de comprobantes

Producción **no conserva** las imágenes recibidas. El backend descarga la media de WhatsApp, valida tipo/tamaño, calcula el hash, ejecuta OCR y utiliza los bytes únicamente durante esa solicitud.

Después del procesamiento no se guarda:

- la imagen;
- `media_id` como dato del pago;
- un `receipt_file_id`;
- una URL o copia en Drive/S3/Blob.

Sí se conserva `file_hash` (SHA-256) porque permite reconocer un reenvío exacto sin almacenar el documento bancario. Si un caso requiere una revisión visual futura, el encargado tendría que solicitar que el comprobante sea reenviado; la verificación financiera de todas formas se hace contra el movimiento real del banco.

## Autenticación

El panel de producción usa:

- clave administrativa definida por ambiente;
- comparación temporalmente segura;
- cookie de sesión firmada HMAC;
- `HttpOnly`, `SameSite=Strict`, `Secure` en producción;
- comprobación de mismo origen para acciones mutables.

La demo pública no reutiliza datos de producción.

## Verificación y conciliación

En el MVP el encargado revisa BAC independientemente y usa el botón del panel para cambiar un pago elegible a `VERIFICADO`. La aplicación no necesita ni debe almacenar usuario, contraseña, PIN o códigos bancarios.

`reconcilePendingPayments` queda preparado para una futura fuente autorizada. Requiere una coincidencia consistente de banco, referencia y monto; una discrepancia de fecha va a revisión. Para verificar automáticamente, el movimiento además debe traer un identificador estable. Ese `bank_movement_id` se persiste en el pago y no puede utilizarse para verificar otro pago ni en la misma corrida ni en una corrida posterior.

Si la fuente bancaria no entrega un identificador estable de movimiento, el sistema falla de forma conservadora: no verifica automáticamente y manda el caso a revisión.

La fuente de movimientos se mantiene abstracta para incorporar posteriormente un archivo bancario, notificación oficial o API autorizada.
