# Qué le dice el sistema al residente, en cada momento

Todo lo que sale por WhatsApp, en el orden en que puede pasar. Los textos de abajo están
**copiados de la salida real** del sistema, no transcritos a mano: se obtuvieron corriendo cada
flujo contra el procesador.

Dos reglas que valen para todos:

- **La vivienda se escribe con guiones:** `E1-B4-C18`, no `E1B4C18`. Pegado se lee como una
  matrícula; con guiones se ven las tres partes de un vistazo. `viviendas.codigo` sigue
  guardando la forma pegada —es clave de unicidad— y se traduce al mostrarla.
- **Lo que se enseña tiene que poder volver a entrar.** El parser acepta `E1-B4-C18`,
  `E1 B4 C18`, `E1B4C18`, `e1-b4-c18`, `etapa 1 bloque 4 casa 18` y las variantes con letras
  (`E1-BA-C18`, `E2-B3-C12B`). Hay una prueba que lo ata: cambiar el ejemplo sin cambiar el
  parser rompe CI.

---

## 1. Manda un comprobante

### Sale bien

```
✅ Comprobante recibido
Etapa 1 · Bloque 4 · Casa 18
L150.00
Fecha depósito: 07/09/2026
Mes aplicado: septiembre de 2026
Estado: pendiente de verificación.
```

**Recibido no es verificado** (invariante 2). El pago queda esperando a que aparezca en el
extracto del banco; el recibo numerado llega después, en el paso 4.

### El comprobante no trae la vivienda

```
Recibimos tu comprobante por L150.00, pero falta saber de qué vivienda es.
Respondé con tu etapa, bloque y casa.
Si vivís en la etapa 3, bloque 1, casa 1, tu dirección se escribe así: E3-B1-C1
```

Se abre un contexto de hasta **3 intentos**. El comprobante ya está guardado: no hace falta
reenviarlo.

### Trae la vivienda, pero esa vivienda no existe

```
Recibimos tu comprobante por L150.00, pero no encontramos esa vivienda.
Puede que la etapa, el bloque o la casa estén escritos distinto. Verificá los tres.
Si vivís en la etapa 3, bloque 1, casa 1, tu dirección se escribe así: E3-B1-C1
```

Es **distinto** del anterior a propósito: acá el residente sí escribió la vivienda. Decirle que
falta un dato que ya mandó lo hace buscar el error donde no está.

### El monto no es el de la cuota

```
Recibimos tu comprobante y lo estamos revisando. Te avisamos en cuanto quede confirmado
contra el estado de cuenta del banco.
```

El pago queda `EN_REVISION` para que lo mire una persona. Hoy **cualquier** monto distinto de
la cuota cae acá, el múltiplo exacto incluido (ver sección 7 del plan).

### No se reconoce un comprobante en la imagen

```
No reconocimos un comprobante de pago en esa imagen. No se registró ningún pago.
Si es un comprobante del banco, enviá la captura completa, sin recortar los bordes.
```

### Es el mismo comprobante que ya mandó

```
ℹ️ Este mismo comprobante ya había sido recibido. No se registró un segundo pago.
```

### La vivienda está inactiva

No recibe un mensaje distinto —le llega el de revisión— porque **lo resuelve el administrador**:
una casa inactiva que paga es justo la que hay que volver a activar.

---

## 2. Contesta de qué vivienda es

### No se entiende lo que escribió

```
No logramos identificar la vivienda.
Necesitamos las tres cosas: etapa, bloque y casa.
Si vivís en la etapa 3, bloque 1, casa 1, tu dirección se escribe así: E3-B1-C1
Escribí solo la vivienda, sin el nombre ni el mes.
```

En el último intento, la línea final cambia a *«Si no sale esta vez, lo revisa una persona.»*

### Escribió una vivienda que no existe

```
No encontramos esa vivienda.
Puede que la etapa, el bloque o la casa estén escritos distinto. Verificá los tres y volvé a enviarlos.
Si vivís en la etapa 3, bloque 1, casa 1, tu dirección se escribe así: E3-B1-C1
Si no sale esta vez, lo revisa una persona.
```

### Contestó bien

```
✅ Comprobante registrado para Etapa 1, Bloque 4, Casa 18. Mes aplicado: septiembre de 2026.
Estado: pendiente de verificación.
```

### Se acabaron los tres intentos

```
No pudimos identificar la vivienda, así que lo va a revisar una persona.
Tu comprobante está guardado: no hace falta que lo envíes de nuevo.
```

---

## 3. El tesorero manda el extracto del banco

Solo desde un número con rol **ADMIN** o **TESORERO**.

Llega un resumen y luego:

```
Para aplicar el extracto respondé SI. Para descartarlo, NO.
```

Si responde `NO`:

```
Descartado. No se aplicó nada.
```

Errores posibles del archivo:

| Qué pasó | Qué se le dice |
|---|---|
| Los saldos no cuadran | Ese archivo no cuadra: los saldos no suman. Volvé a descargarlo del banco sin modificarlo. |
| Es de otra cuenta | Ese extracto no es de la cuenta de cobro. Revisá que sea la cuenta correcta. |
| Ya lo había mandado | Ese archivo ya lo habías mandado. Si querés aplicarlo, respondé SI al resumen anterior. |
| Dice SI y no hay nada pendiente | No hay ningún extracto esperando confirmación. |
| La confirmación venció | Esa confirmación ya venció o el extracto ya se aplicó. Mandá el archivo de nuevo. |

La confirmación vence a las **2 horas** (`PAGOS_CONFIRMACION_MINUTOS`).

---

## 4. El recibo

Sale **horas después**, así que cae fuera de la ventana de 24 horas de Meta y va por la
plantilla aprobada `recibo_pago` (invariante 13). El cuerpo está en
[`docs/PLANTILLAS_WHATSAPP.md`](PLANTILLAS_WHATSAPP.md):

```
Recibo REC-000012
Vivienda: E1-B4-C18
Mes: septiembre de 2026
Monto: L150.00
Forma de pago: Transferencia
Referencia: ****4821
Fecha de pago: 07/09/2026
Verificado: 09/09/2026
```

Dos casos donde **no** sale ningún recibo:

- **El cobro en efectivo quedó en revisión** (la casa ya había pagado, o está inactiva): sin
  mes tomado, sin recibo y sin mensaje. El cobrador le dicta el número si corresponde.
- **No se dejó teléfono o no hubo consentimiento.** El pago vale igual y aparece en «recibos no
  entregados» del panel. La pantalla del cobrador avisa que no se va a enviar nada.

---

## Lo que el sistema nunca manda

- Mensajes de cobranza o recordatorios de mora. Hoy no existen.
- Nada fuera de la ventana de 24 h que no sea la plantilla aprobada.
- Ningún mensaje con el teléfono, el nombre o el monto de **otra** vivienda.
