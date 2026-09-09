# Pagos residenciales por WhatsApp

Plataforma de automatización de cobros residenciales por WhatsApp con OCR, validación de transacciones, control de cartera y dashboard administrativo.

> **Importante:** un comprobante leído por OCR no demuestra que el dinero exista. El sistema separa explícitamente `comprobante recibido` de `pago verificado`. En la primera etapa un encargado revisa el movimiento directamente en el banco y pulsa **Verificar**; una fuente bancaria automatizada puede integrarse después.

> **Retención:** por decisión actual del cliente, las imágenes de comprobantes **no se guardan**. Se descargan temporalmente desde WhatsApp, se validan, se calcula su hash, se procesan con OCR y después se descartan. Sólo quedan los datos estructurados necesarios y el SHA-256 para detectar reenvíos exactos.

## Objetivo

Automatizar el flujo operativo de una empresa residencial que recibe comprobantes bancarios por WhatsApp:

`Vecino/tercero → WhatsApp → imagen temporal → validación/hash → OCR → parser bancario → Etapa/Bloque/Casa → filtro de duplicados → registro de datos → revisión/verificación → dashboard → respuesta`

El MVP inicia con **BAC Honduras**, pero los parsers están desacoplados para incorporar otros bancos sin reescribir la lógica central.

## Reglas de negocio definitivas

- La vivienda se identifica únicamente por **Etapa + Bloque + Casa**.
- El formato recomendado para el detalle y para la respuesta por WhatsApp es `E1 B4 C18`.
- Si falta etapa, bloque, casa o cualquiera de los tres datos es inválido, se piden **los tres nuevamente**.
- El teléfono que envía el WhatsApp **nunca determina la vivienda**. Sólo sirve para responder al remitente y relacionar temporalmente una respuesta `E1 B4 C18` con su comprobante pendiente.
- El nombre del depositante tampoco determina la vivienda.
- El número de teléfono no se almacena en la base maestra `Viviendas`.
- La cuota bancaria esperada del MVP es **L150.00**. Un comprobante por menos o por más de L150 no se descarta: sus datos se conservan y pasa a `EN_REVISION` con el motivo exacto.
- Un caso con monto distinto de L150 no puede pasar a `VERIFICADO` sólo por pulsar el botón de comprobación bancaria; debe mantenerse como excepción hasta que exista una regla administrativa explícita para resolverlo.
- Agosto 2026 es el mes base del histórico:
  - depósitos 01–14 de agosto → julio 2026;
  - depósitos 15–31 de agosto → agosto 2026;
  - desde septiembre, el sistema aplica el nuevo depósito al primer mes **no verificado como pagado** desde agosto;
  - un comprobante meramente recibido o en revisión no hace avanzar el histórico: si llega otro comprobante, ambos compiten por el mismo primer mes pendiente y el conflicto se envía a revisión;
  - si todos los meses hasta el mes del depósito ya están verificados, no adelanta silenciosamente a un mes futuro: deja el caso visible para revisión/corrección.
- La **fecha de depósito** proviene del comprobante; el **mes pagado** es un dato separado.
- Una vivienda se considera **pagada** en el dashboard sólo cuando el pago del período está `VERIFICADO`.
- Una referencia bancaria repetida es una **señal de revisión**, no un duplicado automático, porque no se asume que sea globalmente única para siempre.
- El mismo `message_id` de Meta es un retry técnico y se ignora silenciosamente.
- El mismo archivo exacto (`SHA-256`) es una señal fuerte de reenvío; si llega desde otro remitente se manda a revisión para no revelar ni reasignar datos de terceros.
- Las imágenes de comprobantes no se archivan ni se exponen posteriormente desde el panel.
- Un pago sólo pasa a `VERIFICADO` después de una comprobación bancaria humana o una futura fuente bancaria confiable.

## Capacidades implementadas

- Webhook de WhatsApp Cloud API con verificación y firma `X-Hub-Signature-256`.
- Retry técnico de Meta detectado antes de volver a descargar media o ejecutar OCR cuando el `message_id` ya fue procesado.
- Descarga server-side temporal; JPG/JPEG y PNG con validación de MIME, magic bytes y tamaño antes de OCR.
- SHA-256 persistido para detectar reenvíos exactos sin conservar la imagen.
- OCR local/server-side con Tesseract.js + modelo español y preprocesamiento Sharp.
- Parser BAC para banco, depositante, fecha, hora, monto, detalle, referencia, beneficiario y cuenta destino enmascarada.
- Parser de vivienda completo para `E1 B4 C18`, `Etapa 1 Bloque 4 Casa 18`, `E1-B4-C18` y variantes de orden/espaciado siempre que estén los tres componentes.
- Contexto pendiente único por remitente de WhatsApp para pedir E/B/C sin repetir OCR.
- Validación automática de cuota: exactamente L150 sigue el flujo normal; monto menor/mayor pasa a revisión humana.
- Idempotencia por `message_id` y detección de reenvío exacto por hash.
- Referencias repetidas, coincidencias débiles y conflictos de datos enviados a revisión humana en vez de descartarse automáticamente.
- Motivo de duplicado/conflicto persistido para trazabilidad administrativa.
- Conflictos entre remitentes/viviendas enviados a revisión sin revelar datos de terceros.
- Estados separados para recibido, pendiente de verificación, verificado, duplicado, no encontrado, revisión y rechazo.
- Google Sheets privado como tabla operativa (`Pagos`, `Viviendas`, `Conversaciones`, `Mensajes`, `Conciliacion`, `Configuracion`).
- Base maestra de viviendas editable desde el panel: etapa, bloque, casa, responsable opcional, cuota, alta/baja y estado activo.
- Política de minimización: no Google Drive, no `receipt_file_id`, no `media_id` persistido, no URL histórica del comprobante.
- Dashboard mensual: viviendas, pagadas verificadas, pendientes, cobranza, esperado, recibido, verificado, pendiente y sin identificar.
- Vistas por etapa/bloque y por vivienda, incluyendo historial de cuatro períodos y detalle completo de datos estructurados.
- Bandejas de pagos, depósitos sin identificar, duplicados confirmados y casos en revisión.
- Corrección administrativa de vivienda y mes pagado sin repetir OCR; una corrección que choque con otro pago vuelve a revisión.
- Verificación manual desde el panel después de revisar el movimiento bancario.
- Conciliación determinística preparada para una futura fuente bancaria; un mismo movimiento bancario nunca puede verificar dos pagos distintos.
- Panel administrativo protegido con sesión HttpOnly firmada y clave por ambiente.
- Demo pública completamente sintética y separada de producción.
- Suite de pruebas y CI aislado.

## Estados

```text
COMPROBANTE_RECIBIDO
  ↓
PROCESANDO
  ↓
EXTRAIDO
  ├─ falta E/B/C → ESPERANDO_RESPUESTA → PENDIENTE_VERIFICACION
  ├─ monto ≠ L150 → EN_REVISION
  ├─ mismo archivo exacto → DUPLICADO / EN_REVISION según contexto
  ├─ referencia repetida o conflicto → EN_REVISION
  └─ válido → PENDIENTE_VERIFICACION
                    ↓
            REVISION DEL BANCO
              ├─ confirmado y sin excepción pendiente → VERIFICADO
              ├─ no existe → NO_ENCONTRADO
              └─ ambiguo/excepción → EN_REVISION
```

## Estructura

```text
pagos-whatsapp-residencial/
├── app/                    # UI, panel y Route Handlers de Next.js
├── src/
│   ├── auth/               # sesión administrativa
│   ├── config/             # contrato de variables de entorno
│   ├── demo/               # datos sintéticos
│   ├── domain/             # estados, períodos, vivienda, duplicados
│   ├── ocr/                # Sharp + Tesseract.js
│   ├── parsers/            # parsers desacoplados por banco
│   │   └── bac/
│   ├── security/           # archivos, firmas y logging seguro
│   ├── services/           # procesamiento, meses, dashboard, historial, conciliación
│   ├── storage/            # Google Sheets y memoria demo
│   └── whatsapp/           # payload y cliente Cloud API
├── tests/
├── docs/
├── AGENTS.md
└── .env.example
```

## Demo vs producción

### Demo

`APP_MODE=demo`

- no utiliza Meta, Google ni credenciales;
- no acepta el webhook real;
- usa únicamente datos ficticios;
- permite mostrar dashboard, parser, E/B/C, meses, duplicados y excepciones sin exponer información sensible.

### Producción

`APP_MODE=production`

Requiere variables de entorno en Vercel. Copiar `.env.example` sólo como referencia; **nunca** rellenarlo y subirlo al repositorio.

Variables principales:

- `EXPECTED_PAYMENT_AMOUNT` (150 en el MVP)
- `ADMIN_ACCESS_KEY`
- `AUTH_SESSION_SECRET`
- `GOOGLE_SHEET_ID`
- `GOOGLE_CLIENT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `WHATSAPP_VERIFY_TOKEN`
- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `META_APP_SECRET`
- `WHATSAPP_GRAPH_VERSION`
- `EXPECTED_BENEFICIARY` (opcional)
- `EXPECTED_ACCOUNT_LAST4` (opcional)

No se requiere `GOOGLE_RECEIPT_FOLDER_ID` ni ningún almacenamiento de objetos para los comprobantes.

## Ejecución local

Requiere Node.js 22 o superior.

```bash
npm install
npm run dev
```

Validación completa:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Webhook

Endpoint:

```text
GET/POST /api/whatsapp/webhook
```

En producción:

1. `GET` valida `hub.mode`, `hub.verify_token` y devuelve `hub.challenge`.
2. `POST` lee el cuerpo crudo y valida HMAC-SHA256 antes de parsear JSON.
3. sólo procesa mensajes soportados;
4. los textos normales se ignoran salvo que exista un comprobante pendiente de E/B/C;
5. un retry técnico con el mismo `message_id` no vuelve a descargar el archivo, no repite OCR y no genera una respuesta intencional;
6. la media descargada se utiliza durante la solicitud y no se archiva después del OCR/parser.

## Google Sheets

El backend crea/valida las hojas requeridas y usa `valueInputOption=RAW` para evitar que texto extraído por OCR se convierta en fórmulas de Sheets.

La vista operativa principal es:

`Etapa | Bloque | Casa | Cuota | Estado | Banco | Referencia | Fecha depósito | Mes pagado | Teléfono WhatsApp`

La Sheet no debe publicarse. El teléfono de WhatsApp vive en `Pagos`/`Conversaciones`, no en `Viviendas`. `Pagos` conserva el hash del archivo, pero no la imagen ni un identificador que permita abrirla desde el panel.

Ver [`docs/SHEETS_SCHEMA.md`](docs/SHEETS_SCHEMA.md).

## Seguridad

El repositorio es público por diseño. Está prohibido versionar:

- tokens, claves o service-account JSON;
- comprobantes reales;
- teléfonos o nombres reales de vecinos;
- números de cuenta o referencias reales;
- archivos exportados desde producción.

Los logs no imprimen payloads completos. Teléfonos, referencias e identificadores se enmascaran cuando se registran eventos operativos.

Ver [`docs/SECURITY.md`](docs/SECURITY.md).

## OCR

La primera versión usa Tesseract.js en Node.js con modelo español local y Sharp para rotación, reducción, escala de grises, normalización y enfoque. No envía el comprobante a un proveedor de IA externo.

PDF no se habilita en el MVP inicial: Tesseract.js procesa imágenes, y añadir rasterización/PDF aumenta peso, superficie de ataque y cold start. El usuario recibe una instrucción clara para enviar JPG/PNG.

Ver [`docs/OCR_DECISION.md`](docs/OCR_DECISION.md).

## Verificación y conciliación

En el MVP operativo el encargado:

1. abre/revisa el movimiento en BAC por su cuenta;
2. compara banco, monto, fecha y referencia disponible con los datos extraídos del comprobante;
3. si es un pago normal de L150 sin otra excepción, pulsa **Verificar** o, para una revisión resoluble, **Verifiqué en banco**;
4. si el monto es menor o mayor de L150, el caso permanece en revisión aunque el movimiento exista en BAC;
5. el sistema registra fuente y fecha de verificación sólo cuando el pago es elegible.

Como la imagen no se conserva, una revisión visual posterior requiere solicitar un reenvío. La existencia del dinero siempre se confirma contra el banco, no por apariencia del comprobante.

`src/services/reconciliation.ts` queda preparado para una futura carga de archivo/API bancaria. Exige coincidencias consistentes y además impide que un mismo movimiento bancario verifique dos pagos.

Nunca se requiere guardar usuario, contraseña, PIN ni códigos de BAC en el proyecto.

## Pruebas

La suite cubre, entre otros:

- BAC válido y sin vivienda;
- requisito de Etapa + Bloque + Casa completos;
- reintentos técnicos y reenvíos exactos;
- referencia repetida como revisión, no duplicado automático;
- archivo/MIME inválido;
- firma del webhook;
- acceso administrativo y sesión manipulada;
- cuenta destino inesperada;
- monto menor/mayor a L150 enviado a revisión;
- excepciones de monto bloqueadas para verificación simple;
- contexto pendiente y asignación posterior sin re-OCR;
- histórico base de agosto y asignación del primer mes pendiente usando sólo pagos verificados;
- un recibo no verificado no marca una vivienda como pagada ni adelanta automáticamente el mes siguiente;
- unicidad de vivienda por E/B/C;
- historial mensual por vivienda;
- conciliación sin reutilizar un mismo movimiento bancario;
- esquema de Sheets sin `media_id`/`receipt_file_id`;
- exclusión de duplicados en totales.

Todos los datos de prueba son sintéticos.

## Limitaciones actuales del MVP

- Banco parseado: BAC Honduras.
- Entrada de comprobantes: JPG/JPEG y PNG; PDF se rechaza de forma segura.
- Las imágenes no se conservan por decisión del cliente; una revisión visual posterior requiere reenvío.
- La verificación bancaria automática aún necesita una fuente bancaria real autorizada; por ahora se hace manualmente desde el panel.
- Los pagos en efectivo se dejan para una fase posterior de ingreso manual por encargados.
- Las excepciones de monto distinto de L150 quedan deliberadamente en revisión hasta definir cómo administrar abonos parciales, pagos múltiples, créditos o devoluciones.
- Google Sheets es apropiado para el volumen residencial del MVP, pero no es una base transaccional; una evolución de alto volumen debe usar un datastore con unicidad/transactions y mantener Sheets como salida operativa.
- La demo pública no ejecuta OCR binario real: usa texto OCR sintético y el parser real para demostrar reglas sin publicar imágenes de banca.

## Documentación

- [Arquitectura](docs/ARCHITECTURE.md)
- [Esquema de Google Sheets](docs/SHEETS_SCHEMA.md)
- [Seguridad y privacidad](docs/SECURITY.md)
- [Decisión de OCR](docs/OCR_DECISION.md)

## Portafolio

Este proyecto debe presentarse como una **plataforma de automatización de cobros residenciales**, no como un OCR aislado. Demuestra integración de APIs, backend, frontend, procesamiento documental transitorio, minimización de datos, seguridad, idempotencia, reglas de negocio, excepciones, revisión humana, conciliación, pruebas y CI/CD.
