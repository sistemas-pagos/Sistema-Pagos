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
- el padrón de `viviendas` no guarda teléfono;
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
- al finalizar no se copia a Drive, Blob, S3 ni otro almacenamiento;
- no se persiste `media_id` ni un identificador de archivo recuperable;
- sólo se conserva el SHA-256 y los datos estructurados necesarios para operar.

El hash permite reconocer un archivo exactamente igual sin conservar el documento bancario. La ausencia de archivo histórico reduce exposición de datos sensibles, pero significa que una revisión visual futura requerirá que el comprobante sea reenviado.

### Monto

- la cuota vigente vive en `cuotas` con su `vigente_desde`, así que un mes viejo cuesta lo que
  costaba entonces; `EXPECTED_PAYMENT_AMOUNT` es solo el respaldo mientras esa tabla esté vacía;
- el dinero se guarda en centavos enteros: nada se redondea al guardarlo (invariante 7);
- un monto igual a la cuota puede continuar al estado pendiente de verificación;
- un múltiplo exacto se reparte en meses atrasados, nunca futuros;
- cualquier otro monto se conserva pero pasa a `EN_REVISION`;
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

Una transferencia queda `VERIFICADO` contra un movimiento del extracto del banco, que el tesorero
manda por WhatsApp desde un número autorizado, o cuando el encargado revisa el movimiento por su
cuenta y ejecuta una acción permitida del panel. El sistema no almacena usuario, contraseña, PIN
ni códigos de BAC.

Cada pago verificado guarda su `movimiento_id`, y esa columna es **UNIQUE en la base**: un
movimiento no puede verificar dos pagos, ni en la misma corrida ni en otra. No depende de que
alguien recuerde comprobarlo en un camino de código nuevo.

El efectivo no se verifica contra el banco —no hay movimiento que mirar— y por eso su control es
otro: el cobrador registra, el tesorero recibe, y el esquema exige `cobrador_id <> tesorero_id`
para que nadie reciba lo que él mismo cobró.

### Histórico mensual

- la fecha de depósito no equivale al mes de servicio;
- **septiembre de 2026 es el primer mes de servicio**; no se asigna nada antes, y la deuda
  anterior entra una sola vez como `ajustes` de tipo `SALDO_INICIAL`;
- sólo un período `VERIFICADO` hace avanzar al siguiente mes pendiente;
- un comprobante sólo recibido no cambia una deuda pendiente en deuda pagada;
- un mes pendiente queda reservado por el pago que lo tomó: el índice único parcial de
  `pago_meses` impide que dos pagos activos se lleven el mismo mes de la misma vivienda.

Esto evita que dos comprobantes pendientes hagan avanzar artificialmente el histórico antes de comprobar que el dinero existe.

### Ningún servicio de Google

No hay cuenta de servicio, ni hoja de cálculo, ni Drive: nada del sistema habla con Google. Es una
credencial menos que existe y que se podría filtrar. La cuenta destino del banco se guarda
enmascarada.

### Panel

- cada persona entra con su usuario y su rol; las claves van con `scrypt` y los parámetros del
  coste viajan junto al hash;
- la clave se verifica aunque el usuario no exista, contra un hash señuelo, para que el tiempo de
  respuesta no distinga un usuario real de uno inventado;
- la sesión lleva firmado quién es y con qué rol: editarlo en la cookie rompe la firma y no se
  puede ascender solo;
- `ADMIN_ACCESS_KEY` es la clave compartida anterior y existe solo mientras la variable esté
  configurada; la sesión que crea se anota como `panel`, no como una persona, y no puede recibir
  una caja;
- sesión HMAC con expiración;
- cookie HttpOnly + SameSite Strict + Secure en producción;
- comprobación de mismo origen en escrituras;
- el panel muestra datos estructurados, no imágenes históricas de comprobantes;
- los casos de revisión requieren acciones explícitas;
- excepciones que comprometen contabilidad (monto que no es múltiplo de la cuota, conflicto de
  período o reutilización de movimiento bancario) no pueden saltarse con el botón de verificación;
- el cobrador ve estado y no datos: ni el depositante, ni el teléfono de otro vecino, ni el monto
  de otra casa salen de la capa de servicio. Un dato que no sale no se filtra por accidente en una
  pantalla.

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
- archivos exportados de producción;
- teléfonos, nombres o referencias bancarias reales.

Los fixtures actuales usan nombres, teléfonos y referencias deliberadamente ficticios.

## Límites conocidos

Al no conservar comprobantes, una investigación visual posterior no puede abrir la imagen original desde el panel. El encargado deberá revisar el movimiento real del banco y, si necesita volver a ver el documento, solicitar un reenvío. Este límite es intencional mientras el cliente no autorice almacenamiento de comprobantes.

El envío de respuesta por WhatsApp no usa todavía un outbox durable. Si Meta acepta el comprobante pero falla el envío de la respuesta, el pago permanece seguro y no se duplica, pero el mensaje al usuario puede necesitar reintento operativo. Un outbox durable es una mejora prioritaria antes de escalar.

## Rotación y respuesta a incidentes

Ante sospecha de filtración:

1. revocar/rotar token de Meta;
2. rotar el token de Turso (se revoca en Turso, se actualiza el secreto del Environment y no hay
   que tocar código);
3. rotar `ADMIN_ACCESS_KEY` y `AUTH_SESSION_SECRET`, y cambiar la clave de cada usuario;
4. revisar logs sin descargar PII innecesaria;
5. invalidar despliegues anteriores si contienen configuración comprometida;
6. revisar historial Git antes de asumir que borrar un archivo lo eliminó del repositorio.
