# Esquema operativo de Google Sheets

La hoja de cálculo es **privada**. El backend valida/crea las pestañas necesarias y escribe con `valueInputOption=RAW` para evitar formula injection desde texto OCR.

Las imágenes de comprobantes **no se almacenan**. Se descargan temporalmente desde WhatsApp, se validan, se calcula su SHA-256, se ejecuta OCR y después se descartan. La Sheet conserva únicamente datos estructurados y el hash necesario para detectar reenvíos exactos.

## Modelo de negocio

La cobranza se separa en tres conceptos:

1. `Viviendas`: quién debe pagar. Una fila = una vivienda.
2. `Pagos`: qué comprobantes/dinero llegaron. Una fila = un pago recibido.
3. `EstadoMensual`: quién está pagado, por verificar, en revisión o pendiente en un mes. Una fila = una vivienda + un período.

`EstadoMensual` es una **vista derivada**, no una fuente de verdad ni una pestaña que se edite manualmente. El backend la reconstruye desde `Viviendas + Pagos` cada vez que la necesita. Esto evita que una celda editada a mano pueda contradecir el historial real.

Su clave lógica es:

`period + stage + block + house`

Estados de cobranza:

- `PAGADO`: existe al menos un pago `VERIFICADO` para la vivienda y el período.
- `POR_VERIFICAR`: existe un comprobante utilizable asignado, pero todavía no está confirmado por el banco.
- `EN_REVISION`: existe una excepción sin resolver, como monto distinto de L150 o movimiento no encontrado.
- `PENDIENTE`: no existe un comprobante utilizable asignado a esa vivienda/período.

## Vista operativa esperada

La información que necesita el encargado se presenta como:

`Etapa | Bloque | Casa | Cuota | Estado | Monto recibido | Comprobantes | Fecha depósito`

y, para el detalle de pagos:

`Etapa | Bloque | Casa | Cuota | Estado pago | Banco | Referencia | Fecha depósito | Mes pagado | Teléfono WhatsApp`

El teléfono es el número que envió el comprobante por WhatsApp. **Nunca identifica la vivienda.**

La cuota esperada del MVP es **L150.00**. El monto del comprobante se conserva como dato bancario independiente: si es menor o mayor de L150, el pago queda en `EN_REVISION` y no se considera pagado/verificado automáticamente.

## `Pagos`

| Columna | Uso |
| --- | --- |
| `id` | ID interno determinístico del comprobante procesado |
| `created_at` / `updated_at` | auditoría temporal |
| `source_message_id` | idempotencia de WhatsApp |
| `phone` | remitente de WhatsApp; dato privado, no identidad de vivienda |
| `bank` | banco detectado |
| `depositor` | depositante/remitente extraído |
| `transaction_date` / `transaction_time` | fecha/hora del depósito según comprobante |
| `amount` | monto declarado por el comprobante; se compara contra la cuota esperada |
| `detail` | detalle/concepto |
| `reference` | referencia/transacción bancaria; señal de comparación, no ID global único |
| `beneficiary` | beneficiario extraído |
| `destination_account_masked` | sólo últimos cuatro dígitos |
| `stage` / `block` / `house` | identidad operativa de la vivienda |
| `period` | mes de servicio pagado `YYYY-MM` |
| `status` | estado de la máquina de pagos |
| `file_hash` | SHA-256 calculado mientras la imagen está en memoria; la imagen no se conserva |
| `duplicate_of` | pago original relacionado |
| `duplicate_reason` | señal exacta que originó duplicado/conflicto |
| `review_reason` | motivo interno de revisión, por ejemplo monto menor/mayor a L150 |
| `verification_source` | fuente usada para verificar |
| `verified_at` | fecha/hora de verificación |
| `bank_movement_id` | identificador estable del movimiento bancario usado por una fuente de conciliación automática; no se reutiliza en otro pago |

No existen columnas `media_id` ni `receipt_file_id`, porque el sistema no conserva una referencia reutilizable a la imagen recibida.

## `Viviendas`

| Columna | Uso |
| --- | --- |
| `id` | ID interno |
| `stage` / `block` / `house` | clave operativa principal y única |
| `responsible` | dato administrativo opcional |
| `monthly_fee` | cuota mensual esperada |
| `active` | vivienda activa/inactiva |
| `start_date` / `end_date` | vigencia para períodos históricos |

**No existe columna de teléfono en `Viviendas`.** Una casa puede estar alquilada y el pago puede enviarlo cualquier tercero. Ni el remitente de WhatsApp ni el nombre del depositante se utilizan para determinar la vivienda.

## `EstadoMensual` (vista derivada)

Una fila representa exactamente una vivienda vigente en un mes de servicio.

| Campo derivado | Uso |
| --- | --- |
| `period` | período `YYYY-MM` |
| `home_id` | ID de la vivienda maestra |
| `stage` / `block` / `house` | identidad E/B/C |
| `monthly_fee` | cuota esperada tomada de `Viviendas` |
| `collection_status` | `PAGADO`, `POR_VERIFICAR`, `EN_REVISION` o `PENDIENTE` |
| `received_amount` | suma de comprobantes utilizables asignados a esa casa/mes |
| `payment_count` | cantidad de comprobantes utilizables asignados |
| `payment_id` | pago representativo para seguimiento, si existe |
| `payment_date` | fecha de depósito del pago representativo |

Reglas:

- `DUPLICADO` y `RECHAZADO` no participan en `received_amount` ni cambian el estado mensual.
- `VERIFICADO` tiene prioridad y convierte la vivienda/mes en `PAGADO`.
- si no hay verificado pero existe `EN_REVISION` o `NO_ENCONTRADO`, el estado mensual es `EN_REVISION`;
- si sólo hay comprobantes recibidos/procesados/pendientes de verificación, es `POR_VERIFICAR`;
- sin comprobante utilizable, es `PENDIENTE`.
- la vista se puede reconstruir determinísticamente; no se corrige editando celdas.

## `Conversaciones`

| Columna | Uso |
| --- | --- |
| `id` | ID del contexto temporal |
| `phone` | remitente de WhatsApp |
| `payment_id` | comprobante esperando Etapa/Bloque/Casa |
| `created_at` | creación |
| `expires_at` | expiración |

El teléfono se usa únicamente para relacionar una respuesta posterior `E1 B4 C18` con el comprobante pendiente de esa conversación. No crea una asociación permanente teléfono → vivienda. Sólo debe existir un contexto vigente por remitente para evitar respuestas ambiguas.

## `Mensajes`

| Columna | Uso |
| --- | --- |
| `message_id` | ID de WhatsApp |
| `received_at` | recepción |
| `kind` | image/document/text/other |
| `outcome` | processed/ignored/rejected |

## `Conciliacion`

Reservada para trazabilidad de futuras corridas de conciliación y fuentes bancarias autorizadas. Una misma transacción/movimiento bancario nunca puede verificar dos pagos distintos.

Para conciliación automática segura, la fuente debe aportar un identificador estable de movimiento. Si no existe `bank_movement_id`, el sistema no verifica automáticamente y manda el caso a revisión. Cuando un movimiento se usa, su ID queda persistido en `Pagos` y no puede volver a verificar otro pago en una corrida posterior.

## `Configuracion`

Reservada para parámetros operativos no secretos. **Nunca** guardar tokens, contraseñas, llaves privadas ni secretos de Meta/Google/BAC en esta hoja.

## Mes pagado

Agosto 2026 es el punto de inicio del histórico:

- depósitos del 1 al 14 de agosto de 2026 → julio 2026;
- depósitos del 15 al 31 de agosto de 2026 → agosto 2026;
- desde septiembre, el sistema busca el primer mes **no verificado como pagado** desde agosto;
- un comprobante `PENDIENTE_VERIFICACION` o `EN_REVISION` no hace avanzar el histórico; si llega otro, se mantiene el mismo primer mes pendiente y el conflicto se revisa;
- si todos los meses hasta el mes del depósito ya están `VERIFICADO`, no se avanza silenciosamente a un mes futuro: el caso queda visible para revisión/corrección.

## Estado operativo

- `PENDIENTE_VERIFICACION`: el comprobante fue recibido y parece válido, pero el banco aún no fue confirmado.
- `VERIFICADO`: el encargado confirmó el movimiento bancario o una futura fuente bancaria confiable lo confirmó.
- `EN_REVISION`: existe una excepción que requiere decisión humana; incluye montos diferentes de L150.
- `DUPLICADO`: no debe volver a contabilizarse.

Una vivienda se considera **pagada** para el período únicamente cuando existe un pago `VERIFICADO` para ese E/B/C y mes.

## Reglas

- No publicar la Sheet.
- No usar fórmulas provenientes de OCR.
- No almacenar el texto OCR completo salvo necesidad futura explícita.
- No almacenar imágenes de comprobantes ni IDs de archivo/media una vez finalizado el procesamiento.
- Conservar `file_hash` para idempotencia/detección de reenvío sin conservar la imagen.
- Cuenta destino: conservar sólo versión enmascarada.
- Secretos: únicamente variables de entorno de Vercel.
- Una referencia bancaria repetida no se descarta automáticamente como duplicado.
- Un monto distinto de L150 se conserva y se manda a revisión; no se corrige ni se descarta automáticamente.
- Un `bank_movement_id` ya utilizado no puede verificar otro pago.
- Si una hoja existente tiene encabezados inesperados, el backend falla de forma cerrada en lugar de sobrescribir datos.
