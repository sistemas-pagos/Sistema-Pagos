import spa from '@tesseract.js-data/spa';
import { createWorker, OEM, PSM } from 'tesseract.js';
import { preprocessReceiptForOcr } from './preprocess';

export interface OcrResult {
  text: string;
  confidence: number;
}

export interface ReceiptRecognizer {
  recognize(bytes: Buffer): Promise<OcrResult>;
  close(): Promise<void>;
}

async function startWorker() {
  const worker = await createWorker('spa', OEM.LSTM_ONLY, {
    langPath: spa.langPath,
    gzip: spa.gzip,
    cacheMethod: 'none',
  });
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.AUTO,
    preserve_interword_spaces: '1',
  });
  return worker;
}

/**
 * Un worker de Tesseract que se reutiliza para varios comprobantes.
 *
 * Arrancarlo cuesta segundos porque carga el modelo del idioma. En una corrida
 * que procesa varios mensajes seguidos conviene pagar ese costo una sola vez
 * (docs/PLAN.md, fase 1). Hay que cerrarlo al terminar.
 */
export async function createReceiptRecognizer(): Promise<ReceiptRecognizer> {
  const worker = await startWorker();
  return {
    async recognize(bytes: Buffer): Promise<OcrResult> {
      const prepared = await preprocessReceiptForOcr(bytes);
      const result = await worker.recognize(prepared);
      return {
        text: result.data.text.trim(),
        confidence: Number.isFinite(result.data.confidence) ? result.data.confidence / 100 : 0,
      };
    },
    async close(): Promise<void> {
      await worker.terminate();
    },
  };
}

/** Un solo comprobante: arranca el worker, reconoce y lo cierra. */
export async function recognizeReceipt(bytes: Buffer): Promise<OcrResult> {
  const recognizer = await createReceiptRecognizer();
  try {
    return await recognizer.recognize(bytes);
  } finally {
    await recognizer.close();
  }
}
