# Plan de implementación — Sistema de Pagos (MVP v2)

Este documento reemplaza las decisiones anteriores cuando haya conflicto. Implementar **una fase por PR**, con pruebas primero.

## 1. Decisiones tomadas

- Métodos de pago: **transferencia** (cuenta bancaria exclusiva) y **efectivo**. Sin pagos adelantados.
- Identidad de vivienda: **Etapa + Bloque + Casa** (texto; admite letras). Código compacto `E1B4C18`.
- **Turso** es la única fuente de verdad (base nueva, sin relación con otros proyectos).
- **Google Sheets** es solo lectura (dashboard, pendientes, excepciones, cierres).
- **Google Form** para el cobro en efectivo.
- **GitHub Actions** hace el trabajo pesado. **Vercel** solo aloja el webhook mínimo y el panel.
- **Sin Apps Script.**
- La verificación de transferencias se hace enviando el **CSV del banco por WhatsApp** desde un número autorizado.
- Cada pago verificado recibe un **número de recibo único** y se notifica al vecino por WhatsApp.

## 2. Arquitectura

```
Vecino ──WhatsApp──► Vercel /api/whatsapp/webhook
                       1. valida firma HMAC
                       2. INSERT mensajes (message_id único) → si existe: 200 y fin
                       3. guarda media_id temporal
                       4. repository_dispatch → GitHub
                       5. responde 200

GitHub Actions ─► procesar-comprobantes ─► Turso ─► enviar-recibos ─► WhatsApp
               ─► procesar-efectivo (lee respuestas del Form)
               ─► conciliar-csv
               ─► sincronizar-sheets ─► Google Sheets (solo lectura)
               ─► mantenimiento / cierre-mes
```

## 3. Invariantes (reemplazan las de AGENTS.md)

1. La vivienda nunca se deduce del teléfono ni del nombre del depositante.
2. **Recibido ≠ verificado.** Una casa está pagada solo con un pago `VERIFICADO` (transferencia) o `EFECTIVO_COBRADO`/`VERIFICADO` (efectivo).
3. Una transferencia solo se verifica contra un **movimiento del CSV del banco**. Un movimiento verifica **un solo** pago (restricción UNIQUE).
4. Beneficiario y últimos 4 dígitos de la cuenta destino son **obligatorios** en producción; comparación exacta normalizada. Si no coinciden → `RECHAZADO` (otra cuenta). Si no se leen → `EN_REVISION`.
5. Asignación de mes: el mes más antiguo desde la fecha de alta de la vivienda que no tenga un pago `VERIFICADO` **ni reservado por uno pendiente**. `NO_ENCONTRADO`, `RECHAZADO` y `ANULADO` liberan el mes. Nunca asignar a meses futuros.
6. Monto múltiplo exacto de la cuota vigente → se reparte en meses atrasados (nunca futuros). Cualquier otro monto → `EN_REVISION`.
7. Dinero en **centavos enteros**.
8. Nada se sobrescribe sin evento: toda corrección escribe en `eventos` (quién, antes, después, motivo). `eventos` no se puede editar ni borrar.
9. Un mes cerrado no se modifica; las correcciones entran como ajuste en el mes siguiente.
10. Número de recibo: secuencia única global, nunca reutilizada. Un recibo por pago. Se anula con motivo y se emite otro; nunca se edita.
11. Imágenes de comprobantes: no se guardan. `media_id` se guarda solo hasta procesar el mensaje y luego se borra.
12. Repositorio público: los logs de Actions **nunca** muestran teléfonos, E/B/C, montos por casa, referencias ni nombres. No subir artifacts con datos.
13. Los mensajes al vecino fuera de la ventana de 24 h usan **plantillas aprobadas** de WhatsApp.
14. Meta: reintentos con el mismo `message_id` se ignoran. Errores permanentes se marcan `RECHAZADO` y se avisa al vecino; nunca devolver 500 por un error permanente.

## 4. Esquema Turso (borrador de la migración 001)

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE viviendas (
  id TEXT PRIMARY KEY,
  etapa TEXT NOT NULL, bloque TEXT NOT NULL, casa TEXT NOT NULL,
  codigo TEXT NOT NULL UNIQUE,                -- E1B4C18
  estado TEXT NOT NULL CHECK (estado IN ('ACTIVA','VACIA','EXONERADA','BAJA')),
  fecha_alta TEXT NOT NULL, fecha_baja TEXT,
  UNIQUE (etapa, bloque, casa)
);

CREATE TABLE cuotas (
  id INTEGER PRIMARY KEY,
  monto_centavos INTEGER NOT NULL CHECK (monto_centavos > 0),
  vigente_desde TEXT NOT NULL UNIQUE          -- 'YYYY-MM'
);

CREATE TABLE usuarios (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  email TEXT UNIQUE, telefono TEXT UNIQUE,
  rol TEXT NOT NULL CHECK (rol IN ('ADMIN','TESORERO','COBRADOR')),
  activo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE mensajes (
  message_id TEXT PRIMARY KEY,
  telefono TEXT NOT NULL,
  tipo TEXT NOT NULL,
  media_id TEXT,                               -- se borra al procesar
  estado TEXT NOT NULL CHECK (estado IN ('RECIBIDO','PROCESANDO','PROCESADO','IGNORADO','RECHAZADO','ERROR')),
  intentos INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  recibido_en TEXT NOT NULL, actualizado_en TEXT NOT NULL
);

CREATE TABLE cierres_caja (
  id TEXT PRIMARY KEY,
  cobrador_id TEXT NOT NULL REFERENCES usuarios(id),
  tesorero_id TEXT NOT NULL REFERENCES usuarios(id),
  monto_esperado_centavos INTEGER NOT NULL,
  monto_entregado_centavos INTEGER NOT NULL,
  creado_en TEXT NOT NULL,
  CHECK (cobrador_id <> tesorero_id)
);

CREATE TABLE importaciones_csv (
  id TEXT PRIMARY KEY,
  subido_por TEXT NOT NULL REFERENCES usuarios(id),
  archivo_sha256 TEXT NOT NULL UNIQUE,
  estado TEXT NOT NULL CHECK (estado IN ('PENDIENTE_CONFIRMACION','APLICADA','CANCELADA','EXPIRADA')),
  resumen_json TEXT, expira_en TEXT NOT NULL, creado_en TEXT NOT NULL
);

CREATE TABLE movimientos_banco (
  id TEXT PRIMARY KEY,
  importacion_id TEXT NOT NULL REFERENCES importaciones_csv(id),
  fecha TEXT NOT NULL, referencia TEXT, descripcion TEXT,
  monto_centavos INTEGER NOT NULL,
  huella TEXT NOT NULL UNIQUE                  -- hash(fecha|referencia|monto|descripcion)
);

CREATE TABLE pagos (
  id TEXT PRIMARY KEY,
  metodo TEXT NOT NULL CHECK (metodo IN ('TRANSFERENCIA','EFECTIVO')),
  vivienda_id TEXT REFERENCES viviendas(id),
  monto_centavos INTEGER NOT NULL CHECK (monto_centavos > 0),
  fecha_pago TEXT, hora_pago TEXT,
  banco TEXT, referencia TEXT, depositante TEXT, beneficiario TEXT, cuenta_ultimos4 TEXT, detalle TEXT,
  estado TEXT NOT NULL CHECK (estado IN (
    'ESPERANDO_RESPUESTA','PENDIENTE_VERIFICACION','VERIFICADO','EFECTIVO_COBRADO',
    'EN_REVISION','NO_ENCONTRADO','DUPLICADO','RECHAZADO','ANULADO')),
  motivo_revision TEXT,
  telefono_contacto TEXT,                      -- para enviar el recibo
  acepta_whatsapp INTEGER NOT NULL DEFAULT 0,
  message_id TEXT UNIQUE REFERENCES mensajes(message_id),
  archivo_sha256 TEXT,
  form_respuesta_id TEXT UNIQUE,               -- efectivo
  recibo_talonario TEXT UNIQUE,                -- efectivo
  cobrador_id TEXT REFERENCES usuarios(id),
  cierre_caja_id TEXT REFERENCES cierres_caja(id),
  movimiento_id TEXT UNIQUE REFERENCES movimientos_banco(id),
  duplicado_de TEXT REFERENCES pagos(id),
  verificado_por TEXT REFERENCES usuarios(id),
  verificado_en TEXT,
  creado_en TEXT NOT NULL, actualizado_en TEXT NOT NULL
);

CREATE TABLE pago_meses (
  pago_id TEXT NOT NULL REFERENCES pagos(id),
  vivienda_id TEXT NOT NULL REFERENCES viviendas(id),
  periodo TEXT NOT NULL,                       -- 'YYYY-MM'
  monto_centavos INTEGER NOT NULL,
  estado TEXT NOT NULL CHECK (estado IN ('RESERVADO','PAGADO','LIBERADO')),
  PRIMARY KEY (pago_id, periodo)
);
CREATE UNIQUE INDEX ux_mes_activo ON pago_meses (vivienda_id, periodo)
  WHERE estado IN ('RESERVADO','PAGADO');

CREATE TABLE contextos (
  id TEXT PRIMARY KEY,
  pago_id TEXT NOT NULL UNIQUE REFERENCES pagos(id),
  telefono TEXT NOT NULL,
  intentos INTEGER NOT NULL DEFAULT 0,
  estado TEXT NOT NULL CHECK (estado IN ('ABIERTO','RESUELTO','EXPIRADO')),
  expira_en TEXT NOT NULL, creado_en TEXT NOT NULL
);

CREATE TABLE recibos (
  numero INTEGER PRIMARY KEY AUTOINCREMENT,    -- REC-000123
  pago_id TEXT NOT NULL UNIQUE REFERENCES pagos(id),
  estado TEXT NOT NULL CHECK (estado IN ('EMITIDO','ANULADO')),
  motivo_anulacion TEXT,
  reemplaza_a INTEGER REFERENCES recibos(numero),
  emitido_en TEXT NOT NULL
);

CREATE TABLE envios (
  id TEXT PRIMARY KEY,
  recibo_numero INTEGER NOT NULL REFERENCES recibos(numero),
  telefono TEXT NOT NULL,
  plantilla TEXT NOT NULL,
  estado TEXT NOT NULL CHECK (estado IN ('PENDIENTE','ENVIADO','FALLIDO')),
  intentos INTEGER NOT NULL DEFAULT 0,
  wa_message_id TEXT, error TEXT,
  actualizado_en TEXT NOT NULL
);

CREATE TABLE ajustes (
  id TEXT PRIMARY KEY,
  vivienda_id TEXT NOT NULL REFERENCES viviendas(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('SALDO_INICIAL','SALDO_A_FAVOR','DEVOLUCION','AJUSTE')),
  periodo TEXT,
  monto_centavos INTEGER NOT NULL,
  motivo TEXT NOT NULL,
  creado_por TEXT NOT NULL REFERENCES usuarios(id),
  creado_en TEXT NOT NULL
);

CREATE TABLE cierres_mes (
  periodo TEXT PRIMARY KEY,
  cerrado_por TEXT NOT NULL REFERENCES usuarios(id),
  cerrado_en TEXT NOT NULL,
  resumen_json TEXT NOT NULL
);

CREATE TABLE eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entidad TEXT NOT NULL, entidad_id TEXT NOT NULL,
  accion TEXT NOT NULL,
  antes_json TEXT, despues_json TEXT,
  motivo TEXT, actor TEXT NOT NULL,
  creado_en TEXT NOT NULL
);
CREATE TRIGGER eventos_no_update BEFORE UPDATE ON eventos BEGIN SELECT RAISE(ABORT, 'eventos es inmutable'); END;
CREATE TRIGGER eventos_no_delete BEFORE DELETE ON eventos BEGIN SELECT RAISE(ABORT, 'eventos es inmutable'); END;
```

Vistas a crear: `v_estado_mensual`, `v_pendientes_cobro`, `v_excepciones`, `v_recibos_no_entregados`.

Migraciones versionadas en `migrations/NNN_*.sql`, aplicadas por un workflow manual con Environment protegido.

## 5. Workflows de GitHub Actions

| Workflow | Disparador | Función |
|---|---|---|
| `migraciones` | manual | Aplica migraciones pendientes |
| `procesar-comprobantes` | `repository_dispatch` + cron de respaldo | Descarga, OCR, parser, guarda, responde |
| `procesar-efectivo` | cron 5–10 min | Lee respuestas nuevas del Form y crea pago + recibo |
| `conciliar-csv` | `repository_dispatch` | Importa CSV, envía resumen, aplica al recibir "SI" |
| `enviar-recibos` | al terminar los anteriores + cron | Envía plantillas y reintenta fallidos |
| `sincronizar-sheets` | cron 10–15 min + al terminar procesos | Actualiza las pestañas de solo lectura |
| `mantenimiento` | cron diario | Expira contextos y confirmaciones de CSV |
| `cierre-mes` | manual | Cuadra y bloquea el mes |

Reglas para todos: `permissions: contents: read` salvo lo necesario, `concurrency` por workflow, `timeout-minutes`, acciones fijadas por SHA, secretos en el Environment `pagos-produccion`, sin `pull_request_target`, sin artifacts con datos, logs enmascarados.

## 6. Fases y criterios de aceptación

### Fase 0 — Base de datos
- Cliente Turso (`@libsql/client`), migración 001, workflow `migraciones`.
- Repositorio de datos en `src/storage/turso.ts` implementando las operaciones necesarias con transacciones.
- Pruebas contra SQLite local en memoria.
- Aceptación: las restricciones UNIQUE y los triggers de `eventos` están probados.

### Fase 1 — Webhook y procesamiento de comprobantes
- Webhook: insertar `message_id` primero, guardar `media_id`, `repository_dispatch`, responder 200.
- Mover OCR/parser a `procesar-comprobantes`; eliminar `activeMessages`; reutilizar el worker de Tesseract dentro de la corrida.
- Errores permanentes → `RECHAZADO` + aviso al vecino.
- Contexto de E/B/C por comprobante, con límite de intentos; al expirar → `EN_REVISION`.
- Texto sin contexto → respuesta breve con instrucciones.
- Aceptación: reintento concurrente del mismo `message_id` crea un solo pago.

### Fase 2 — Parser y validación
- Reconocer `E1B4C18`, `e1b4c18`, `Etapa1Bloque4Casa18` y bloques/casas con letras.
- Etiquetas exactas; eliminar "Transacción", "De" y "Destino" como etiquetas genéricas.
- Sin fallback al mayor monto del texto; sin buscar E/B/C en todo el texto (solo detalle o respuesta).
- Fechas con mes en texto.
- Beneficiario y cuenta obligatorios; comparación exacta.
- Fixtures con comprobantes BAC reales **anonimizados** (sin datos reales en el repo).
- Aceptación: hallazgos H1, H5, H6 y H7 corregidos (invertir esas pruebas).

### Fase 3 — Reglas de mes y excepciones
- Asignación según invariantes 5 y 6 usando `pago_meses`.
- Fecha de alta de la vivienda respetada.
- Eliminar la regla especial de agosto; cargar saldo inicial como `ajustes`.
- Aceptación: H2, H3 y H4 corregidos.

### Fase 4 — Recibos
- Recibo emitido en la misma transacción que la verificación (transferencia) o el registro (efectivo).
- Cola `envios` y workflow `enviar-recibos` con plantilla aprobada.
- Mensaje: recibo, vivienda, meses, monto, método, referencia enmascarada, fecha de pago y de verificación.
- Anulación con motivo y reemisión.
- Aceptación: no existen dos pagos con el mismo número; reenvío usa el mismo número.

### Fase 5 — Conciliación por CSV vía WhatsApp
- Solo números de `usuarios` con rol ADMIN o TESORERO; CSV o XLSX.
- Importación sin duplicar movimientos; resumen (verificados, depósitos sin comprobante, comprobantes sin depósito).
- Confirmación "SI" que expira; al aplicar, verificar y emitir recibos.
- Adaptar al formato real del CSV de BAC (pendiente de ejemplo).

### Fase 6 — Efectivo
- Leer la hoja de respuestas del Form con la cuenta de servicio.
- Validar correo del cobrador, vivienda, recibo de talonario único, teléfono y consentimiento.
- Crear pago `EFECTIVO_COBRADO` + recibo. Cierre de caja → `VERIFICADO` (sin nuevo recibo).
- Aceptación: una respuesta del Form nunca se procesa dos veces.

### Fase 7 — Sheets, panel y cierre de mes
- `sincronizar-sheets`: Pendientes (después de la fecha límite, excluye por verificar), Dashboard, Excepciones, Recibos no entregados, Cierres.
- Panel: validar estado en cada acción (H8), acciones de rechazar / no encontrado / resolver monto (H9), usuario por persona, límite de intentos de login, todo con `eventos`.
- Cierre de mes con cuadres y bloqueo.
- Quitar almacenamiento en Sheets como base, pestañas sin uso y `activeMessages`; usar `status-machine.ts` en todas las transiciones.

## 7. Pendiente de definir (no inventar; preguntar)

- Fecha límite de pago y fecha de salida de la lista de cobro.
- Tesorero y frecuencia del cierre de caja.
- Tratamiento de montos que no son múltiplos de la cuota.
- Casas vacías o exoneradas.
- Saldo inicial de cada casa.
- Ejemplo real anonimizado del CSV de BAC y de 10–20 comprobantes.
- Texto de las plantillas de WhatsApp para aprobación en Meta.

## 8. Reglas de trabajo

- Una fase por rama `pagos/fase-N-*` y un PR `[PAGOS] ...`.
- Escribir pruebas antes del cambio; `npm run lint`, `typecheck`, `test` y `build` deben pasar.
- No inventar reglas de negocio fuera de este documento; si falta algo, detenerse y preguntar.
- Nunca commitear secretos, datos reales ni archivos exportados de producción.
