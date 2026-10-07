# Plan de implementación — Sistema de Pagos (MVP v2)

Este documento reemplaza las decisiones anteriores cuando haya conflicto. Implementar **una fase por PR**, con pruebas primero.

## 1. Decisiones tomadas

- Métodos de pago: **transferencia** (cuenta bancaria exclusiva) y **efectivo**. Sin pagos adelantados.
- Identidad de vivienda: **Etapa + Bloque + Casa** (texto; admite letras). Código compacto `E1B4C18`.
- **Turso** es la única fuente de verdad (base nueva, sin relación con otros proyectos).
- **Sin Google Sheets, y sin ningún servicio de Google.** El plan original la pedía como
  destino de solo lectura para el dashboard, los pendientes, las excepciones y los cierres.
  Esas cinco vistas se construyeron en el panel, así que Sheets ya no aportaba nada y traía de
  vuelta una cuenta de servicio con sus credenciales. Eduardo la descartó en todo punto el 6
  de octubre de 2026. No se agrega una dependencia ni una credencial de Google sin que él lo
  pida de nuevo.
- **El cobro en efectivo se registra en el panel**, desde el teléfono del cobrador. Antes decía Google Form; se cambió porque registrarlo en el panel elimina la cuenta de servicio de Google, el workflow `procesar-efectivo` y la sincronización de una hoja de respuestas, para el mismo resultado.
- **GitHub Actions** hace el trabajo pesado. **Vercel** solo aloja el webhook mínimo y el panel.
- **Sin Apps Script.**
- La verificación de transferencias se hace contra el **CSV del banco**. El tesorero lo carga en
  **`/admin/extracto`, desde el teléfono**, y también puede mandarlo por WhatsApp desde un número
  autorizado. Los dos caminos llaman al mismo código. El del panel es el recomendado: el extracto
  trae *todos* los movimientos de la cuenta, y mandarlo por WhatsApp es entregárselo a Meta para
  verificar unos pagos.
- Cada pago verificado recibe un **número de recibo único** y se notifica al vecino por WhatsApp.
- **Fecha límite de pago: el último día del mes de servicio.** El mes M vence el último día de M y la vivienda queda morosa por M desde el día 1 de M+1. Se usa el último día y no el 30 para que no haya casos raros: en febrero no existe el 30, y en los meses de 31 días el 31 quedaría fuera de plazo por un día.
- **Mes de ajuste de base: septiembre 2026.** Es el primer mes de servicio del sistema; quien no pague septiembre queda moroso. La deuda anterior a septiembre no se carga como meses ni como pagos: entra una sola vez como `ajustes` de tipo `SALDO_INICIAL` (fase 3).
- **Prórroga del mes de ajuste de base:** hasta el 14 del mes siguiente (14 de octubre de 2026). Es única y no se repite en los meses siguientes.
- Las prórrogas se guardan **como dato por período**, nunca como una excepción escrita en el código. Una excepción de calendario incrustada en el código es justamente lo que la fase 3 viene a eliminar (la regla especial de agosto).

## 2. Arquitectura

```
Vecino ──WhatsApp──► Vercel /api/whatsapp/webhook
                       1. valida firma HMAC
                       2. INSERT mensajes (message_id único) → si existe: 200 y fin
                       3. guarda media_id temporal
                       4. repository_dispatch → GitHub
                       5. responde 200

Cobrador ──teléfono──► /cobros (panel)
                       registra el efectivo, emite recibo y pide el envío

Tesorero ──teléfono──► /admin/extracto (panel)
                       lee el archivo, muestra el resumen y aplica al confirmar

           ──WhatsApp──► el mismo CSV entra como un mensaje más
                       y lo concilia procesar-comprobantes

GitHub Actions ─► procesar-comprobantes ─► Turso ─► enviar-recibos ─► WhatsApp
               ─► mantenimiento / cierre-mes / usuarios / migraciones
```

**Un solo worker para todo lo que llega por WhatsApp.** El comprobante del vecino y el
extracto del tesorero entran por el mismo webhook y salen de la misma cola, así que
`procesar-comprobantes` los atiende a los dos. Un workflow aparte solo para el CSV tendría
que leer la misma cola, con su propio `concurrency`, para hacer lo mismo.

**Dos puertas, una sola lógica.** El extracto cargado en el panel y el mandado por WhatsApp
llaman a las mismas funciones de `src/services/conciliacion.ts`. Lo único distinto es cómo se
confirma: un botón con el resumen a la vista, o un «SI» que vence. Tener dos lógicas según por
qué puerta entró el archivo es como aparecen dos verdades en algo que verifica plata.

El efectivo no pasa por Actions: el cobrador está en la puerta y el número de recibo lo
necesita en el momento.

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

Migraciones versionadas en `migrations/NNN_*.sql`, aplicadas por un workflow manual con
Environment protegido. Una migración aplicada es **inmutable**: el script guarda su `sha256` y
rechaza la corrida si el archivo cambió, así que el esquema se cambia agregando un archivo.

Lo de arriba es el borrador de la `001` y **no es el esquema de hoy**. Producción va por la
`008`; para leer el esquema real hay que leer los archivos. Lo que agregaron las siguientes:

| Migración | Qué agregó |
|---|---|
| `002` | `mensajes.cuerpo`, el texto del mensaje |
| `003` | índice único de un solo recibo `EMITIDO` por pago |
| `004` | `periodo`, `duplicado_motivo` y `verificacion_origen` en `pagos`; `responsable` en `viviendas` |
| `005` | tabla `intentos_login`, para el límite de intentos |
| `006` | un solo `SALDO_INICIAL` por vivienda |
| `007` | `usuario` y `clave_hash`, con índice único parcial |
| `008` | `notas_pago`: lo que el cobrador quiere decir sobre un pago que no puede tocar |

## 5. Workflows de GitHub Actions

Lo que existe hoy en `.github/workflows/`:

| Workflow | Disparador | Función |
|---|---|---|
| `ci` | cada PR y push a `main` | lint, typecheck, test y build |
| `migraciones` | manual | Aplica migraciones pendientes |
| `usuarios` | manual | Sincroniza el número autorizado y fija credenciales |
| `procesar-comprobantes` | `repository_dispatch` + cron `*/10` | Descarga, OCR, parser, guarda, responde. **También concilia el CSV del banco** cuando llega por WhatsApp; el cargado en el panel no pasa por Actions |
| `enviar-recibos` | `repository_dispatch` + al terminar `procesar-comprobantes` + cron `*/15` | Envía plantillas y reintenta fallidos |
| `mantenimiento` | cron diario 07:30 UTC | Expira contextos y confirmaciones de CSV |
| `cierre-mes` | manual, con el período como input | Cuadra y bloquea el mes |

Dos cambios respecto del plan original, los dos por la misma razón —el workflow no aportaba
nada que el existente no hiciera ya:

- **`procesar-efectivo` no existe.** El cobro en efectivo se registra en el panel (sección 1),
  así que no hay hoja de respuestas que leer.
- **`conciliar-csv` no existe como workflow aparte.** Por WhatsApp el CSV entra como un mensaje
  más y lo atiende `procesar-comprobantes`, que ya lee esa cola. Cargado en el panel no toca
  Actions: el tesorero está mirando la pantalla y el resumen lo necesita en el momento, igual
  que el cobrador con su recibo.

**`sincronizar-sheets` no existe y no se va a construir.** El panel muestra hoy el dashboard,
los pendientes, las excepciones, los recibos no entregados y los cierres, que era todo lo que
Sheets iba a servir (sección 1).

El cron de Actions es *best-effort*: lo medimos y los huecos reales son de ~2 horas, no los
10–15 minutos que declara. Por eso lo que tiene que responder rápido no depende del cron —
`enviar-recibos` se dispara con `repository_dispatch` desde el cobro en efectivo y al terminar
`procesar-comprobantes`, y el cron queda como respaldo.

Reglas para todos: `permissions: contents: read` salvo lo necesario, `concurrency` por workflow, `timeout-minutes`, acciones fijadas por SHA, secretos en el Environment `pagos-produccion`, sin `pull_request_target`, sin artifacts con datos, logs enmascarados.

## 6. Fases y criterios de aceptación

**Dónde estamos.** Las fases 0 a 6 están construidas y mergeadas, con la base de producción
migrada hasta la `008`. De la 7 falta un solo punto, y es de orden interno.

| Fase | Estado |
|---|---|
| 0 — Base de datos | ✅ |
| 1 — Webhook y procesamiento | ✅ |
| 2 — Parser y validación | ✅ |
| 3 — Reglas de mes y excepciones | ✅ |
| 4 — Recibos | ✅ |
| 5 — Conciliación por CSV | ✅ (dentro de `procesar-comprobantes`) |
| 6 — Efectivo | ✅ |
| 7 — Panel y cierre de mes | ◐ falta `status-machine`, ver abajo |

Lo que falta **no es código**: el padrón cargado, las credenciales del cobrador y el método
de pago en Meta. Sin padrón no se puede cobrar nada, porque un pago necesita una casa a la
cual asignarse.

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
- Pantalla propia para el cobrador, **diseñada para teléfono**: el panel de admin sigue siendo de escritorio.
- Filtros por etapa, bloque, casa, estado, método y mes, todos como listas. Solo la referencia se escribe.
- El cobrador ve **estado, no datos**: nunca depositante, teléfono ajeno ni monto de otra casa.
- El monto **no se escribe**: se marcan meses y se calcula con la cuota vigente de cada uno. No se cobran meses incompletos.
- Crear pago `EFECTIVO_COBRADO` + recibo en una transacción, y disparar el envío en el momento: el recibo digital es lo único que recibe el vecino.
- Si la casa ya pagó ese mes, el cobro entra `EN_REVISION` con comentario: sin tomar el mes, sin recibo y sin mensaje. El cobrador ya tiene la plata y no registrarla sería peor.
- El total a entregar del cobrador **incluye los cobros en revisión**.
- Cierre de caja → `VERIFICADO` (sin nuevo recibo).
- Aceptación: un cobro a una casa que ya pagó no emite recibo ni encola envío.

### Fase 7 — Panel y cierre de mes

Hecho:

- Panel: estado validado en cada acción (H8), acciones de rechazar / no encontrado / resolver
  monto (H9), **un usuario por persona con su rol** y límite de intentos de login, todo con
  `eventos`.
- Cierre de mes con cuadres y bloqueo (`cierre-mes`, manual, con el período como input).
- Las cinco pantallas que el plan pedía en Sheets, construidas en el panel: Dashboard, Pendientes,
  Excepciones, Recibos no entregados y Cierres.
- Fuera el almacenamiento en Sheets, las pestañas sin uso y `activeMessages`. Ya no queda
  ninguna referencia a los tres.

Falta:

- **`status-machine.ts` en todas las transiciones.** Hoy lo usa `acciones-panel.ts` y nada
  más. Las demás transiciones son correctas, pero cada una decide por su cuenta: la máquina de
  estados existe y no es todavía el único camino.

## 7. Pendiente de definir (no inventar; preguntar)

- Fecha de salida de la lista de cobro.
- **Tesorero y frecuencia del cierre de caja.** El código no asume ninguna de las dos: cierra
  cuando alguien con rol ADMIN o TESORERO lo hace, y no impone frecuencia.
- **Montos distintos de la cuota en transferencias.** Más abierto de lo que decía esta lista:
  la invariante 6 dice que un múltiplo exacto se reparte entre los meses atrasados, y **eso no
  está construido**. Hoy `receiptReviewReason` exige el monto exacto de la cuota y manda a
  `EN_REVISION` todo lo demás, el múltiplo incluido: quien paga dos meses de una vez cae en la
  bandeja. `reservarMeses()` existe en `src/storage/turso.ts` para repartir y no lo llama
  nadie. Con efectivo no puede ocurrir, porque el cobrador marca meses y el total sale de la
  cuota de cada uno.

  Hay que decidir dos cosas antes de construirlo: si el múltiplo se reparte solo o se le
  pregunta al residente, y qué pasa con un monto que no es múltiplo (devolver, dejar a cuenta,
  o revisión como hoy).
- Casas vacías o exoneradas.
- Saldo inicial de cada casa. Es un dato, no una regla: la tabla `ajustes` y la importación en
  `/admin/saldos` ya existen y esperan los montos.
- 10–20 comprobantes reales anonimizados. Hay dos en los fixtures; más casos reales es lo que
  haría al parser confiable de verdad.

Resuelto desde la última versión de este documento:

- **Google Sheets: no.** Eduardo la descartó en todo punto (sección 1). Las cinco vistas que
  iba a servir están en el panel, y no se agrega ninguna dependencia ni credencial de Google.

- **El CSV de BAC.** El formato real está adaptado y documentado en
  `docs/EXTRACTO_BANCARIO.md`: no es una tabla sino tres secciones, y `src/bank/bac-csv.ts`
  las localiza por su fila de encabezado.
- **El texto de la plantilla de WhatsApp.** `recibo_pago` está aprobada en Meta y su cuerpo,
  con el orden exacto de los ocho parámetros, está en `docs/PLANTILLAS_WHATSAPP.md`.

## 8. Reglas de trabajo

- Un cambio por rama `pagos/<tema>` y un PR `[PAGOS] ...`. En la práctica la rama se nombra
  por el tema y no por el número de fase, porque varios PR de la misma fase se pisaban el
  nombre.
- Escribir pruebas antes del cambio; `npm run lint`, `typecheck`, `test` y `build` deben pasar.
- No inventar reglas de negocio fuera de este documento; si falta algo, detenerse y preguntar.
- Nunca commitear secretos, datos reales ni archivos exportados de producción.
