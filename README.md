# Sistema de Pagos

Cobro de la cuota residencial por WhatsApp: el vecino manda su comprobante, el sistema lo lee,
lo verifica contra el extracto del banco y le devuelve un recibo numerado. El cobrador registra
el efectivo desde su teléfono.

El documento que manda es [`docs/PLAN.md`](docs/PLAN.md). Cuando este README y el plan no
coincidan, **gana el plan**.

> **Recibido no es verificado.** Un comprobante leído por OCR no demuestra que el dinero exista.
> Una transferencia solo queda `VERIFICADO` cuando un movimiento del extracto del banco la
> respalda, y un movimiento verifica **un solo** pago.

> **Las imágenes no se guardan.** Se descargan de WhatsApp, se validan, se les calcula el hash,
> se procesan con OCR y se descartan. Queda el SHA-256 para reconocer un reenvío exacto, nunca
> la imagen ni un identificador que permita abrirla.

## Cómo funciona

```text
Vecino ──WhatsApp──► Vercel /api/whatsapp/webhook
                       valida la firma, guarda el mensaje, responde 200

GitHub Actions ─► procesar-comprobantes ─► Turso ─► enviar-recibos ─► WhatsApp
               ─► mantenimiento / cierre-mes
```

**Turso es la única fuente de verdad.** Vercel solo aloja el webhook y el panel; el trabajo
pesado —OCR, conciliación, envíos— corre en GitHub Actions, donde un proceso puede tardar
minutos sin que nadie espere una respuesta HTTP.

El efectivo y el extracto del banco entran por el panel, los dos desde el teléfono: el cobrador
registra el cobro en `/cobros`, y el tesorero carga el CSV del banco en `/admin/extracto`. El
extracto también se acepta por WhatsApp desde un número autorizado, pero el panel es el camino
recomendado — el archivo del banco trae todos los movimientos de la cuenta.

## Las reglas que manda el plan

Las catorce invariantes están en [`docs/PLAN.md`](docs/PLAN.md) sección 3. Las que más se
notan al usar el sistema:

- La vivienda es **Etapa + Bloque + Casa** (`E1B4C18`). Nunca se deduce del teléfono ni del
  nombre del depositante.
- Una casa está pagada solo con un pago `VERIFICADO` (transferencia) o `EFECTIVO_COBRADO` /
  `VERIFICADO` (efectivo).
- **Septiembre de 2026 es el primer mes de servicio.** La deuda anterior no entra como meses ni
  como pagos: entra una sola vez como `ajustes` de tipo `SALDO_INICIAL`.
- La fecha límite es el **último día del mes de servicio**. La prórroga del mes base —hasta el
  14 de octubre de 2026— es única y se guarda como dato del período, no como una excepción
  escrita en el código.
- El mes que se asigna es el más antiguo desde el alta de la vivienda sin pago `VERIFICADO` y no
  reservado por uno pendiente. Nunca un mes futuro.
- El dinero se guarda en **centavos enteros**.
- Nada se sobrescribe sin evento: toda corrección escribe en `eventos`, que no se puede editar
  ni borrar.
- El número de recibo es una secuencia global que **nunca se reutiliza**. Se anula con motivo y
  se emite otro; jamás se edita.

La cuota vigente vive en la tabla `cuotas` con su `vigente_desde`, así que un mes viejo cuesta
lo que costaba entonces. `EXPECTED_PAYMENT_AMOUNT` es solo el respaldo cuando esa tabla todavía
no tiene fila.

## Qué está construido

**Entrada por WhatsApp.** Webhook con verificación de challenge y firma `X-Hub-Signature-256`,
validación de MIME, magic bytes y tamaño antes del OCR, y descarte del reintento de Meta por
`message_id` antes de volver a descargar la media.

**Lectura del comprobante.** Tesseract.js con modelo español y preprocesamiento con Sharp, todo
server-side: el comprobante no se le manda a ningún proveedor de IA. Parser de BAC para banco,
depositante, fecha, hora, monto, detalle, referencia, beneficiario y cuenta destino.

**Verificación contra el banco.** El tesorero carga el CSV del extracto en `/admin/extracto`, o
lo manda por WhatsApp desde un número que está en `usuarios` con rol ADMIN o TESORERO. Los dos
caminos corren el mismo código: importa los movimientos sin duplicarlos, muestra un resumen y
aplica solo al confirmar, y la confirmación expira. Un movimiento verifica un solo pago, y lo
garantiza una restricción UNIQUE.

**Efectivo.** El cobrador entra a `/cobros` desde su teléfono, busca la casa con filtros de
etapa, bloque, casa, estado, método y mes, y marca los meses que paga: **el monto no se
escribe**, sale de la cuota de cada mes. El pago, la reserva de los meses, el recibo y su envío
nacen en una sola transacción. La pantalla se instala como app.

**Entrega.** El cobrador ve su hoja de entrega; el tesorero cuenta y cierra la caja en
`/admin/caja`. Nadie recibe lo que él mismo cobró —lo impide el esquema— y la diferencia entre
lo esperado y lo entregado se guarda tal cual.

**Recibos.** Uno por pago, emitido en la misma transacción que la verificación, enviado con
plantilla aprobada de Meta y con una cola que reintenta. `/admin/recibos` muestra los que no le
llegaron al vecino.

**Panel.** Dashboard mensual, vistas por etapa y bloque, historial por vivienda, bandejas de
excepciones, corrección de vivienda y mes sin repetir OCR, y la bandeja de notas del cobrador
—que no puede corregir un pago, pero sí dejar escrito lo que vio.

**Usuarios.** Cada persona entra con su usuario y su rol (ADMIN, TESORERO, COBRADOR). Las claves
van con `scrypt` y la sesión lleva firmado quién es y con qué rol.

## Estructura

```text
.
├── app/                    # panel, pantalla de cobros y Route Handlers
├── migrations/             # NNN_*.sql, aplicadas solo por el workflow `migraciones`
├── scripts/                # lo que corre en Actions (con `npx tsx`, no con `node`)
├── src/
│   ├── auth/               # claves, sesión, roles y defensa de origen
│   ├── bank/               # lectura del CSV del banco
│   ├── config/             # contrato de variables de entorno
│   ├── demo/               # datos sintéticos
│   ├── domain/             # estados, períodos, vivienda, duplicados, recibo
│   ├── ocr/                # Sharp + Tesseract.js
│   ├── parsers/bac/        # parsers desacoplados por banco
│   ├── security/           # archivos, firmas y logging enmascarado
│   ├── services/           # procesamiento, meses, dashboard, conciliación, cobros
│   ├── storage/            # Turso y memoria para la demo
│   └── whatsapp/           # payload, cliente Cloud API y dispatch
├── tests/
├── docs/
└── .github/workflows/
```

## Demo y producción

**Demo** (`APP_MODE=demo`): sin Meta, sin base de datos y sin credenciales. Usa solo datos
ficticios y no acepta el webhook real. Sirve para mostrar el panel, el parser y las reglas sin
exponer nada.

**Producción** (`APP_MODE=production`): requiere las variables en Vercel y los secretos del
Environment `pagos-produccion` en GitHub. Copiar `.env.example` como referencia y **nunca**
llenarlo y subirlo.

Variables principales:

| Variable | Para qué |
|---|---|
| `PAGOS_TURSO_URL`, `PAGOS_TURSO_TOKEN` | la base, que es la fuente de verdad |
| `AUTH_SESSION_SECRET` | firma de la sesión del panel |
| `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `META_APP_SECRET` | WhatsApp Cloud API |
| `WHATSAPP_TEMPLATE_RECIBO`, `WHATSAPP_TEMPLATE_IDIOMA` | la plantilla aprobada del recibo |
| `PAGOS_GITHUB_REPO`, `PAGOS_DISPATCH_TOKEN` | `repository_dispatch` hacia Actions |
| `EXPECTED_BENEFICIARY`, `EXPECTED_ACCOUNT_LAST4` | obligatorias en producción (invariante 4) |
| `ADMIN_ACCESS_KEY` | transición: abre el panel mientras esté configurada |

`ADMIN_ACCESS_KEY` es la clave compartida anterior a los usuarios por persona. Existe solo
mientras la variable esté puesta: al borrarla de Vercel, ese camino desaparece sin tocar código.
Una sesión creada con ella no es una persona, así que no puede recibir una caja.

Ver [`docs/SETUP_PRODUCTION.md`](docs/SETUP_PRODUCTION.md).

## Ejecución local

Requiere Node.js 22.

```bash
npm install
npm run dev
```

Los cuatro checks, que son los mismos que corre CI en cada pull request y en `main`:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Las pruebas corren contra SQLite en memoria usando **los archivos reales de `migrations/`**, así
que una restricción UNIQUE o un trigger que se rompa en producción se rompe también en la suite.

## Seguridad

El repositorio es público por diseño. Está prohibido versionar tokens, claves, service-account
JSON, comprobantes reales, teléfonos o nombres de vecinos, números de cuenta o referencias
reales, y cualquier archivo exportado de producción.

Los logs de Actions **nunca** muestran teléfonos, Etapa/Bloque/Casa, montos por casa,
referencias ni nombres, y ningún workflow sube artifacts con datos.

Ver [`docs/SECURITY.md`](docs/SECURITY.md).

## Documentación

- [Plan de implementación](docs/PLAN.md) — el documento que manda
- [Arquitectura](docs/ARCHITECTURE.md)
- [Configuración de producción](docs/SETUP_PRODUCTION.md)
- [Usuarios y roles](docs/USUARIOS.md)
- [Seguridad y privacidad](docs/SECURITY.md)
- [Decisión de OCR](docs/OCR_DECISION.md)
- [Plantillas de WhatsApp](docs/PLANTILLAS_WHATSAPP.md)
- [Formato del extracto bancario](docs/EXTRACTO_BANCARIO.md)

## Origen del repositorio

Este proyecto vivía en el monorepo [`Jchernand3z19/Portafolio`](https://github.com/Jchernand3z19/Portafolio)
bajo `pagos-whatsapp-residencial/`. Se extrajo a este repositorio con su historial intacto.
