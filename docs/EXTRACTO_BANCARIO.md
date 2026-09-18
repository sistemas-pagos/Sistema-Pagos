# El extracto del banco: cómo se lee y por qué se desconfía de él

Una transferencia se verifica **solo** contra un movimiento del extracto del banco
(invariante 3). El comprobante que manda el vecino dice lo que el vecino quiso mandar; el
extracto dice lo que el banco recibió. Este documento describe el archivo que el BAC deja
descargar y las comprobaciones que hace `src/bank/bac-csv.ts` antes de creerle.

## No es un CSV de una tabla: son tres

| Sección | Columnas | Qué trae |
|---|---|---|
| Cabecera de la cuenta | 17 | `Número de Clientes, Nombre, Producto, Moneda, Saldo Inicial, …` |
| `Detalle de Estado Bancario` | 7 | los movimientos |
| Totales por código | 5 | `Código Transacción Totales, Cantidad Débitos Totales, …` |

Abrirlo como una sola tabla da basura en las tres. Las secciones se localizan por su fila de
encabezado, comparada sin tildes y sin distinguir mayúsculas.

`Producto`, en la cabecera, es **el número de cuenta al que pertenece el extracto**. Sirve
para comprobar que el archivo es el de la cuenta de cobro y no el de otra: un extracto ajeno
verificaría pagos contra depósitos que nunca entraron.

## Las columnas del detalle

```
Fecha de Transacción, Referencia de Transacción, Código de Transacción,
Descripción de Transacción, Débito de Transacción, Crédito de Transacción,
Balance de Transacción
```

- **Fecha:** `dd/mm/aaaa`.
- **Referencia:** 6 a 9 dígitos. Es la que aparece como `Referencia` en la notificación de
  la app y como `Autorización` en el comprobante de agente — los dos números que el parser
  de comprobantes ya elige (`docs/COMPROBANTES.md`).
- **Código:** `TF`, `CP`, `D5`, `AT`, `KS`… **Informativo: no se filtra por él.**
- **Descripción:** recortada y rellenada a **treinta caracteres exactos**, así que el nombre
  del depositante suele venir cortado. No trae lo que el vecino escribió como detalle.
- **Montos:** punto decimal, sin separador de miles.

El archivo viene en **Windows-1252** con fin de línea CRLF. Leído como UTF-8, `Descripción`
y `Crédito` llegan rotos y no se reconoce ni el encabezado. El importador prueba UTF-8
primero y cae a Windows-1252, para que también sirva una copia reguardada desde Excel.

## Qué cuenta como depósito recibido

**Crédito mayor que cero**, no una lista de códigos. Una transferencia, un depósito en
agente (`DEP.RAPIBAC`) y uno en ventanilla (`DEPOSITO …`) llegan con códigos distintos, y el
día que el banco agregue uno nuevo un filtro por código dejaría de ver pagos sin avisar a
nadie.

## La huella de cada movimiento

`movimientos_banco.huella` es el hash de la **fila entera** normalizada, no de la referencia.

En el extracto real que sirvió de modelo hay **diez referencias repetidas** dentro del mismo
mes: el contador de las compras con tarjeta se reinicia. Una huella hecha solo con la
referencia uniría movimientos distintos, y la UNIQUE que sostiene la invariante 3 —un
movimiento verifica un solo pago— empezaría a rechazar depósitos legítimos.

El `Balance de Transacción` entra en la huella y es lo que la vuelve irrepetible. Como es el
saldo corriente, no cambia entre descargas: dos exportaciones que se solapan producen la
misma huella para el mismo movimiento y la UNIQUE las une en vez de duplicarlas.

## La cadena de balances

El balance de cada fila es el saldo después de esa transacción, así que el archivo forma una
cadena que arranca en el `Saldo Inicial` de la cabecera. **Cuadra al centavo en las 61 filas
del extracto real.** Comprobarla es barato y ataja dos cosas que ninguna otra validación ve:

- **Una coma sin comillas dentro de un monto** corre las columnas una posición, y lo que se
  lee sigue siendo un número válido y plausible: 2.35 donde hay 1234.56. Sin la suma, el
  error es silencioso.
- **Un archivo editado a mano** antes de mandarlo, que es exactamente por donde alguien
  haría pasar un depósito que no existió.

Si la cadena no cuadra, el archivo se rechaza entero (`balance_no_cuadra`). Fallar cerrado
es lo correcto aquí: un extracto que no suma no es un extracto.

## Los montos, en centavos enteros

`parseFloat('150.00') * 100` es la cuenta que produce 14999 donde tiene que haber 15000. Los
centavos se arman con enteros desde el texto (invariante 7).

## Lo que todavía no se sabe

El archivo que sirvió de modelo es el de una cuenta personal, compartido **solo para ver la
estructura**. Falta un extracto real de la cuenta de cobro para confirmar:

- el **código de transacción** con el que llega un depósito de agente (`DEP.RAPIBAC`);
- si un mes con muchos depósitos iguales —misma fecha, mismo monto, referencias
  distintas— cambia algo de lo de arriba.

Ninguna de las dos cosas afecta al filtro por crédito ni a la huella, que es por lo que la
fase puede avanzar sin ellas. Los fixtures de `tests/fixtures/extracto-bac.ts` calcan la
estructura con **todos los valores inventados**: este repositorio es público y por aquí no
pasa un extracto real.
