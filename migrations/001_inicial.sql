-- 001_inicial.sql — esquema inicial de Turso (docs/PLAN.md, seccion 4).
--
-- Reglas que este esquema hace cumplir a nivel de base de datos, no de codigo:
--   * invariante 3  — un movimiento del banco verifica un solo pago (pagos.movimiento_id UNIQUE)
--   * invariante 7  — el dinero se guarda en centavos enteros
--   * invariante 8  — eventos no se puede editar ni borrar (triggers)
--   * invariante 10 — un recibo por pago, numeros que nunca se reutilizan (AUTOINCREMENT)
--   * invariante 14 — un message_id se registra una sola vez (clave primaria)
--
-- foreign_keys es un ajuste de conexion, no del archivo: scripts/migrate.ts lo
-- aplica fuera de la transaccion y src/storage/turso-client.ts lo repite en cada
-- conexion nueva.
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
