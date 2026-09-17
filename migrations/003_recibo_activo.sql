-- Un recibo ACTIVO por pago, no un recibo por pago.
--
-- La migracion 001 dejo `recibos.pago_id` como UNIQUE y al mismo tiempo una
-- columna `reemplaza_a`. Las dos cosas no pueden ser ciertas a la vez: la
-- invariante 10 dice que un recibo se anula con motivo y se emite otro, y con
-- el UNIQUE el segundo INSERT falla. `reemplaza_a` quedaba muerta.
--
-- Lo que se quiere es mas preciso: un pago no puede tener dos recibos EMITIDOS,
-- pero si un EMITIDO y todos los ANULADOS que haga falta. Eso es un indice
-- unico parcial, no una restriccion de columna.
--
-- SQLite no sabe quitar un UNIQUE declarado en la columna, asi que hay que
-- reconstruir la tabla. Es el procedimiento estandar: apagar las claves
-- foraneas, crear la tabla nueva, copiar, borrar la vieja y renombrar.
--
-- Las claves foraneas se apagan solo durante esta migracion: `envios` apunta a
-- `recibos` y sin apagarlas el DROP no pasa. El ejecutor de migraciones las
-- vuelve a encender al terminar cada una, porque es un ajuste de conexion y
-- dejarlo apagado desprotegeria todo lo que venga despues.
--
-- El numero no se reutiliza nunca. Al copiar las filas con su `numero`
-- explicito, AUTOINCREMENT adelanta su contador hasta el maximo copiado, de
-- modo que el proximo recibo sigue la secuencia y no repite uno ya emitido.

PRAGMA foreign_keys = OFF;

CREATE TABLE recibos_nuevo (
  numero INTEGER PRIMARY KEY AUTOINCREMENT,    -- REC-000123
  pago_id TEXT NOT NULL REFERENCES pagos(id),
  estado TEXT NOT NULL CHECK (estado IN ('EMITIDO','ANULADO')),
  motivo_anulacion TEXT,
  reemplaza_a INTEGER REFERENCES recibos(numero),
  emitido_en TEXT NOT NULL,
  -- Un recibo anulado sin motivo no deja saber por que se anulo, que es
  -- justamente lo que la invariante 10 pide registrar.
  CHECK (estado <> 'ANULADO' OR motivo_anulacion IS NOT NULL)
);

INSERT INTO recibos_nuevo (numero, pago_id, estado, motivo_anulacion, reemplaza_a, emitido_en)
  SELECT numero, pago_id, estado, motivo_anulacion, reemplaza_a, emitido_en FROM recibos;

DROP TABLE recibos;

ALTER TABLE recibos_nuevo RENAME TO recibos;

CREATE UNIQUE INDEX ux_recibo_activo ON recibos (pago_id) WHERE estado = 'EMITIDO';
