-- 004_pago_campos.sql — lo que le falta a `pagos` para guardar un pago entero.
--
-- La fase 7 mueve el almacenamiento de Google Sheets a Turso. Al calzar el
-- modelo contra el esquema aparecieron tres datos que la hoja guardaba y la
-- tabla no tenia donde poner. Sin ellos, mover el almacen perderia informacion
-- en silencio, que es peor que no moverlo.
--
-- `periodo` es el mes de servicio que cubre el pago. El destino de ese dato es
-- `pago_meses`, que ademas admite varios meses (invariante 6) y reserva el mes
-- con `ux_mes_activo` (invariante 5). No se escribe todavia a proposito: hoy los
-- duplicados se detectan por message_id, sha del archivo y referencia, nunca por
-- casa y mes, asi que la restriccion rechazaria el segundo pago de una misma
-- casa y mes y el flujo actual no sabe que hacer con ese rechazo. Esa es
-- justamente la fase 3, y cuando llegue esta columna se va.
--
-- Las tres son ADD COLUMN sobre columnas nulas: no reescriben la tabla ni tocan
-- una sola fila existente.
ALTER TABLE pagos ADD COLUMN periodo TEXT;

-- Por que se marco como duplicado: el sha del archivo repetido, la referencia
-- reusada. Es distinto de `motivo_revision`, que dice por que lo mira una
-- persona.
ALTER TABLE pagos ADD COLUMN duplicado_motivo TEXT;

-- Que archivo del banco lo verifico. Cuando alguien pregunte por que un pago
-- quedo verificado, esto es lo que lo responde.
ALTER TABLE pagos ADD COLUMN verificacion_origen TEXT;

-- El responsable de la vivienda, que el padron trae y no tenia donde ir.
ALTER TABLE viviendas ADD COLUMN responsable TEXT;
