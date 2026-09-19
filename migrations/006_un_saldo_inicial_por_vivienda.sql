-- 006_un_saldo_inicial_por_vivienda.sql — la deuda vieja entra una sola vez.
--
-- El plan lo dice en la seccion 1: la deuda anterior a septiembre de 2026 no se
-- carga como meses ni como pagos, entra **una sola vez** como un ajuste de tipo
-- SALDO_INICIAL. "Una sola vez" es la garantia que falta.
--
-- Sin ella, pegar el archivo de saldos dos veces —que es justo lo que pasa
-- cuando uno no esta seguro de si la primera importacion entro— duplicaria la
-- deuda de todas las casas a la vez, en silencio y sin que ninguna pantalla lo
-- muestre raro. Es el tipo de error que se descubre meses despues, cobrando de
-- mas.
--
-- Va como indice unico parcial y no como comprobacion en el codigo: los otros
-- tipos de ajuste (SALDO_A_FAVOR, DEVOLUCION, AJUSTE) se repiten cuantas veces
-- haga falta, y solo este no.
CREATE UNIQUE INDEX ux_saldo_inicial_por_vivienda
  ON ajustes (vivienda_id)
  WHERE tipo = 'SALDO_INICIAL';
