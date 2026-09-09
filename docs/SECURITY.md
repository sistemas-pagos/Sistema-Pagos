# Seguridad y privacidad

## Modelo de amenaza resumido

El sistema procesa documentos bancarios y datos de contacto. Las amenazas prioritarias son:

- webhook falso;
- archivo malicioso o con MIME suplantado;
- reenvío/retry que contabilice dos veces;
- comprobante editado o reutilizado;
- asignación incorrecta de vivienda;
- monto distinto a la cuota tratado por error como pago normal;
- filtración de PII o secretos en GitHub/logs;
- persistencia innecesaria de comprobantes bancarios;
- acceso público al panel;
- formula injection en Google Sheets;
- conflicto de referencia que revele información de otra vivienda;
- reutilización de un mismo movimiento bancario para verificar dos pagos.

## Controles implementados

### Webhook

- `GET` sólo acepta token de verificación correcto.
- `POST` valida `X-Hub-Signature-256` con HMAC-SHA256 sobre el body crudo.
- payload acotado con Zod antes de procesarlo.
- mensajes normales no se convierten en pagos; un texto sólo se interpreta como vivienda si existe contexto pendiente.

### Vivienda y teléfono

- la identidad de vivienda es únicamente `Etapa + Bloque + Casa`;
- si falta cualquiera de los tres valores se solicitan los tres de nuevo (`E1 B4 C18`);
- el número de WhatsApp se conserva como remitente del pago y como clave temporal de conversación, nunca como vínculo vivienda → teléfono;
- `Viviendas` no guarda teléfono para resolver pagos;
- el depositante extraído por OCR tampoco determina la vivienda.

Esto evita asignaciones incorrectas cuando una vivienda está alquilada o paga un familiar, propietario u otra persona.

### Archivos y minimización de datos

- formatos del MVP: JPEG/PNG;
- límite configurable de bytes;
- MIME declarado y magic bytes deben coincidir;
- SHA-256 antes de OCR;
- Sharp recibe el binario sólo después de las validaciones iniciales;
- PDF no se procesa en esta fase;
- la imagen existe sólo durante el procesamiento de la solicitud;
- al finalizar no se copia a Google Drive, Blob, S3 ni otro almacenamiento;
- no se persiste `media_id` ni un identificador de archivo recuperable;
- sólo se conserva el SHA-256 y los datos estructurados necesarios para operar.

El hash permite reconocer un archivo exactamente igual sin conservar el documento bancario. La ausencia de archivo histórico reduce exposición de datos sensibles, pero significa que una revisión visual futura requerirá que el comprobante sea reenviado.

### Monto

- cuota bancaria esperada: `EXPECTED_PAYMENT_AMOUNT=150`;
- exactamente L150 puede continuar al estado pendiente de verificación;
- monto menor o mayor se conserva pero pasa a `EN_REVISION`;
- una excepción de monto no puede borrarse usando el botón simple de verificación bancaria;
- no se infieren abonos parciales, pagos de varios meses, créditos o devoluciones hasta que exista una regla explícita.

### Duplicados e idempotencia

- `message_id`: retry técnico, silencioso;
- hash: mismo archivo exacto, sin necesidad de conservar la imagen;
- mismo archivo exacto desde otro remitente: revisión;
- banco + referencia: señal de correlación, **no** duplicado automático;
- referencia repetida con vivienda/monto/fecha incompatibles: revisión/conflicto;
- señal débil banco + vivienda + monto + fecha: sólo revisión;
- un conflicto de período no puede verificarse sin resolver antes el mes correcto;
- el dashboard excluye únicamente filas explícitamente marcadas `DUPLICADO` o `RECHAZADO` de lo recibido, y sólo considera pagada una vivienda después de `VERIFICADO`.

### Fraude y verificación

OCR no autentica una imagen. Estados como `PENDIENTE_VERIFICACION`, `NO_ENCONTRADO` y `EN_REVISION` impiden convertir una captura legible en dinero confirmado.

En el MVP, `VERIFICADO` sólo se obtiene cuando el encargado revisa el movimiento directamente en el banco y ejecuta una acción permitida de verificación del panel. El sistema no almacena usuario, contraseña, PIN ni códigos de BAC.

Una futura conciliación puede usar una fuente bancaria autorizada. Para verificar automáticamente exige un identificador estable del movimiento. Ese `bank_movement_id` se persiste en el pago y se consulta en corridas posteriores: si ya está asociado a otro pago, el nuevo caso se bloquea para revisión en lugar de verificarse. La protección aplica tanto dentro de una misma corrida como entre corridas diferentes.

### Histórico mensual

- la fecha de depósito no equivale al mes de servicio;
- agosto 2026 es la base histórica con el corte inicial acordado;
- desde septiembre sólo un período `VERIFICADO` hace avanzar al siguiente mes pendiente;
- un comprobante sólo recibido no cambia una deuda pendiente en deuda pagada.

Esto evita que dos comprobantes pendientes hagan avanzar artificialmente el histórico antes de comprobar que el dinero existe.

### Google

- sólo Google Sheets es necesario para el MVP actual;
- la Sheet permanece privada y server-side;
- `valueInputOption=RAW` evita ejecutar contenido OCR como fórmula;
- cuenta destino se guarda enmascarada;
- no se requiere Google Drive ni una carpeta de comprobantes.

### Panel

- clave administrativa por ambiente;
- comparación temporalmente segura;
- sesión HMAC con expiración;
- cookie HttpOnly + SameSite Strict + Secure en producción;
- comprobación de mismo origen en escrituras;
- el panel muestra datos estructurados, no imágenes históricas de comprobantes;
- los casos de revisión requieren acciones explícitas;
- excepciones que comprometen contabilidad (monto distinto de L150, conflicto de período o reutilización de movimiento bancario) no pueden saltarse con el botón de verificación.

### Logs

No registrar:

- body completo del webhook;
- OCR completo;
- access tokens;
- llaves privadas;
- comprobantes;
- teléfonos/referencias sin enmascarar.

El logger estructurado incluye únicamente campos mínimos y utilidades de masking.

## Repositorio público

Nunca versionar:

- `.env*` con valores;
- service-account JSON;
- credenciales descargadas;
- comprobantes reales;
- exports de Sheets de producción;
- teléfonos, nombres o referencias bancarias reales.

Los fixtures actuales usan nombres, teléfonos y referencias deliberadamente ficticios.

## Límites conocidos

Al no conservar comprobantes, una investigación visual posterior no puede abrir la imagen original desde el panel. El encargado deberá revisar el movimiento real del banco y, si necesita volver a ver el documento, solicitar un reenvío. Este límite es intencional mientras el cliente no autorice almacenamiento de comprobantes.

Google Sheets no garantiza unicidad transaccional ante escrituras concurrentes desde múltiples instancias. El MVP tiene idempotencia de aplicación y controles de revisión; para crecimiento o alta concurrencia debe introducirse un datastore transaccional con índices únicos y mantener Sheets como salida operativa.

El envío de respuesta por WhatsApp no usa todavía un outbox durable. Si Meta acepta el comprobante pero falla el envío de la respuesta, el pago permanece seguro y no se duplica, pero el mensaje al usuario puede necesitar reintento operativo. Un outbox durable es una mejora prioritaria antes de escalar.

## Rotación y respuesta a incidentes

Ante sospecha de filtración:

1. revocar/rotar token de Meta;
2. rotar credenciales o clave de servicio de Google según corresponda;
3. rotar `ADMIN_ACCESS_KEY` y `AUTH_SESSION_SECRET`;
4. revisar logs sin descargar PII innecesaria;
5. invalidar despliegues anteriores si contienen configuración comprometida;
6. revisar historial Git antes de asumir que borrar un archivo lo eliminó del repositorio.
