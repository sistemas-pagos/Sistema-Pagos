# Decisión de OCR para el MVP

## Selección

**Tesseract.js 7 + modelo español local + Sharp**.

## Razones

### Privacidad

El comprobante se procesa en la función Node.js. No es necesario enviar una imagen bancaria a un proveedor externo de IA/OCR.

### Costo

Tesseract.js y el modelo son open source; no existe costo por página para el MVP.

### Control

BAC tiene una estructura relativamente repetible. La estrategia prioriza:

`preprocesamiento de imagen → OCR → parser BAC determinístico`

sobre pedir a un modelo generativo que interprete y decida reglas críticas.

### Despliegue

Sharp prepara la imagen mediante:

- rotación por metadata;
- reducción de ancho máximo;
- escala de grises;
- normalización;
- enfoque moderado;
- salida PNG.

Tesseract.js usa español y devuelve texto + confianza. El parser no depende de posiciones absolutas de píxeles.

## Alternativas consideradas

### OCR cloud administrado

Ventajas: precisión y soporte documental fuertes.

Desventajas para esta fase: costo variable, credenciales adicionales y transferencia de contenido bancario a un tercero. Se deja como opción futura sólo después de revisar privacidad y términos.

### IA multimodal

Ventajas: flexibilidad con formatos distintos.

Desventajas: costo, menor determinismo, privacidad y riesgo de convertir inferencias en reglas financieras. No se usa para lógica crítica del MVP.

### Scribe.js / pipeline PDF

Puede ampliar soporte documental, pero aumenta el peso y complejidad. Tesseract.js por sí mismo trabaja con imágenes y no ofrece el flujo PDF requerido.

## PDF

El MVP rechaza PDF de forma explícita y solicita JPG/PNG. Esto evita fingir soporte parcial o inseguro.

La fase PDF deberá agregar:

1. validación real de PDF;
2. límites de páginas y tamaño;
3. rasterización controlada/sandboxed;
4. protección frente a documentos complejos o bombas de recursos;
5. benchmarks en Vercel;
6. tests específicos.

## Criterio de éxito

Para BAC, el parser debe recuperar de manera consistente:

- banco;
- monto;
- referencia;
- fecha/hora cuando estén legibles;
- depositante/beneficiario cuando estén presentes;
- detalle;
- bloque/casa.

Los campos críticos faltantes no se inventan: se rechazan o envían a revisión.
