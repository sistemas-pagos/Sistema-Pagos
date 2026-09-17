# Plantillas de WhatsApp

Un recibo sale horas después de que el vecino escribió, así que cae fuera de la ventana de
24 horas y Meta solo acepta ahí una **plantilla aprobada** (invariante 13). El texto se
registra y se aprueba antes de poder usarse; el sistema solo rellena los `{{n}}`.

Aprobar una plantilla suele tardar de minutos a un día. Conviene mandarla apenas la cuenta
de WhatsApp Business exista, sin esperar a que el resto esté listo.

## `recibo_pago`

Es la única plantilla que la fase 4 necesita.

- **Nombre:** `recibo_pago`
- **Categoría:** `UTILITY` (es un recibo de una transacción, no publicidad). Elegir
  `MARKETING` la haría más lenta de aprobar y sujeta a otras reglas.
- **Idioma:** Español (`es`)

**Cuerpo:**

```
Recibo {{1}}
Vivienda: {{2}}
Mes: {{3}}
Monto: {{4}}
Forma de pago: {{5}}
Referencia: {{6}}
Fecha de pago: {{7}}
Verificado: {{8}}
```

Sin encabezado, sin pie y sin botones: cuantas menos partes tenga, menos motivos hay para
que la rechacen.

### Ejemplo para el formulario de Meta

Meta pide valores de muestra para revisar la plantilla. Estos sirven y no son datos reales:

| | Ejemplo |
|---|---|
| `{{1}}` | `REC-000012` |
| `{{2}}` | `E1B4C18` |
| `{{3}}` | `septiembre de 2026` |
| `{{4}}` | `L150.00` |
| `{{5}}` | `Transferencia` |
| `{{6}}` | `*****4321` |
| `{{7}}` | `05/09/2026` |
| `{{8}}` | `06/09/2026` |

### El orden importa

Los ocho parámetros los arma `parametrosDePlantilla` en `src/domain/recibo.ts`, en ese
orden exacto. Si el texto aprobado termina con otro orden, hay que cambiarlo ahí y no en el
script de envío, que solo pasa la lista.

`{{6}}` va enmascarada a propósito: el mensaje se puede reenviar a cualquier chat, y los
últimos cuatro dígitos alcanzan para que el vecino reconozca su depósito.

`{{3}}` puede nombrar varios meses —«septiembre de 2026 y octubre de 2026»— porque un monto
múltiplo de la cuota se reparte entre meses atrasados (invariante 6).

Cuando falta un dato, el parámetro va como `—`. Meta rechaza los parámetros vacíos, así que
nunca se manda una cadena en blanco.

## Después de aprobarla

Si el nombre aprobado no es `recibo_pago`, hay que decírselo al sistema con la variable
`WHATSAPP_TEMPLATE_RECIBO` del Environment `pagos-produccion`. El idioma se cambia con
`WHATSAPP_TEMPLATE_IDIOMA`. Las dos son variables, no secretos: no hay nada que ocultar en
el nombre de una plantilla.
