# Comprobantes: cómo se reconoce cada banco

Un comprobante llega como una foto o una captura. El OCR devuelve texto plano, sin
posiciones, y a partir de ahí hay que decidir **de qué banco es** y **qué dice**. Este
documento explica cómo está resuelto y cómo agregar el siguiente banco.

## Reconocer el banco: tres señales, hacen falta dos

Cada parser puntúa el texto y gana el que más puntúe, si pasa de `0.5`. El puntaje del BAC
suma tres señales independientes:

| Señal | Peso | Qué mira |
|---|---|---|
| Marca | 0.45 | `BAC`, `Credomatic`, `RAPIBAC`, `CNB Honduras` |
| Documento | 0.35 | `Notificación de transferencia`, `Resultado de transferencia`, `Copia del cliente`, `Tipo de Transacción` |
| Etiquetas | 0.20 | al menos 4 de: Fecha, Hora, Monto, Detalle, Descripción, Referencia, Comprobante, Cuenta |

**Ninguna señal sola llega al umbral.** Es deliberado, y no es teoría: la versión anterior
identificaba el banco buscando la palabra "BAC", y **dos de cada ocho comprobantes reales se
rechazaban enteros** — uno porque un banner de "Favorito guardado" tapaba el logo en la
captura, otro porque la pantalla de resultado de la app no escribe "BAC" en ninguna parte.

Pedir dos señales de tres también protege al revés: un comprobante de otro banco que use las
mismas etiquetas no entra como BAC y se lee con las reglas equivocadas.

## Los tres formatos del BAC

Salen de mirar dieciséis comprobantes reales. Los fixtures que los copian están en
`tests/fixtures/comprobantes-bac.ts`, con la estructura calcada y **todos los valores
inventados**: este repositorio es público.

| | Notificación | Pantalla de resultado | Agente (pulpería) |
|---|---|---|---|
| Logo | sí, salvo que lo tape un banner | **nunca** | sí |
| Beneficiario | dentro de la frase | bloque `Cuenta destino` | `Cliente:` |
| Cuenta | completa, en la frase | bajo el nombre | `Número de Cuenta: *****NNNN` |
| Fecha | `16 septiembre 2026` | `14 septiembre`, **sin año** | `15/09/26` |
| Hora | `2:45 PM` | no trae | `14:53:52` |
| Referencia | `Referencia` | `N° comprobante` | `Autorización` |
| Vivienda | en `Detalle`, si el vecino la escribe | en `Descripción` | nunca |

### Decisiones que no son obvias

**El beneficiario nunca está tras una etiqueta que se llame "Beneficiario".** Está dentro de
una frase (*"a la cuenta bancaria Nº … a nombre de …"*), o en un bloque de tres líneas, o
bajo `Cliente:`. Sin leer las tres formas, la invariante 4 manda todos los pagos a revisión y
el sistema no verifica ninguno solo.

**En el comprobante de agente hay dos números que compiten por ser la referencia.** Se usa
`Autorización`, no `Referencia`: esa última es el contador interno de la pulpería, de seis
dígitos, que se reinicia y se repite entre agentes distintos. Dos pagos hechos en pulperías
distintas parecerían el mismo.

**Los valores se parten en varias líneas.** El detalle largo, y el nombre del titular incluso
a mitad de palabra. Una línea que no abre otra etiqueta conocida pertenece a la anterior.

**La etiqueta se recorta exacta, no hasta el primer `:` de la línea.** En `Hora 2:45 PM` el
primer `:` es el de la hora, y cortar ahí dejaba `45 PM`.

## Lo que el OCR no puede hacer

- **Letra manuscrita.** En los depósitos de agente los vecinos escriben la vivienda a mano
  sobre el papel. Tesseract lee texto impreso; con lapicero sobre papel térmico no hay nada
  que ajustar. Esos comprobantes necesitan que el vecino escriba la vivienda **en el mensaje**,
  o que una persona la lea.
- **Fotos de lejos o desenfocadas.** Ahí sí sirve pedir otra foto, y conviene pedirla en el
  momento: el vecino tiene el comprobante en la mano.

## Agregar un banco nuevo

1. Juntar comprobantes reales de ese banco, de todos sus canales (app, pantalla, agente).
2. Copiar la estructura a un fixture en `tests/fixtures/`, con valores inventados.
3. Escribir el parser con su `detect` de señales múltiples y registrarlo en `src/parsers/index.ts`.
4. Una prueba por cada cosa que el formato haga distinto.

**Un banco a la vez.** Cada uno enseña algo que no estaba previsto, y mezclarlos hace que no
se sepa cuál rompió qué.
