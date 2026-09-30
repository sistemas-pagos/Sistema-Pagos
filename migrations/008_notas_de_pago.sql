-- Lo que el cobrador quiere decir sobre un pago que no puede tocar.
--
-- El cobrador no edita ni borra nada: solo agrega cobros. Cuando algo no
-- cuadra —cobro a una casa que ya pago, se equivoco de vivienda, el vecino
-- dijo algo que importa— lo unico que puede hacer es dejarlo escrito para que
-- el admin decida.
--
-- No es un estado del pago. `EN_REVISION` significa que el sistema no supo que
-- hacer con el; una nota es alguien contando algo. Mezclarlos dejaria sin
-- saber si la revision la pidio una persona o la dedujo el sistema.
CREATE TABLE notas_pago (
  id TEXT PRIMARY KEY,
  pago_id TEXT NOT NULL REFERENCES pagos(id),
  autor_id TEXT NOT NULL REFERENCES usuarios(id),
  texto TEXT NOT NULL,
  -- ABIERTA hasta que el admin la cierra. Una nota resuelta no desaparece:
  -- queda con su texto, que es lo que explica por que el pago quedo como quedo.
  estado TEXT NOT NULL CHECK (estado IN ('ABIERTA','RESUELTA')),
  resuelta_por TEXT REFERENCES usuarios(id),
  resuelta_en TEXT,
  creada_en TEXT NOT NULL,
  -- Una nota resuelta sin quien ni cuando no deja auditar nada.
  CHECK (estado <> 'RESUELTA' OR (resuelta_por IS NOT NULL AND resuelta_en IS NOT NULL))
);

-- La bandeja del admin: las abiertas, mas viejas primero.
CREATE INDEX ix_notas_abiertas ON notas_pago (estado, creada_en);
