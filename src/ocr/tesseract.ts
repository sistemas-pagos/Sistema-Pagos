import spa from '@tesseract.js-data/spa';
import { createWorker, OEM, PSM } from 'tesseract.js';
import { preprocessReceiptForOcr } from './preprocess';

export interface OcrResult {
  text: string;
  confidence: number;
}

export async function recognizeReceipt(bytes: Buffer): Promise<OcrResult> {
  const prepared = await preprocessReceiptForOcr(bytes);
  const worker = await createWorker('spa', OEM.LSTM_ONLY, {
    langPath: spa.langPath,
    gzip: spa.gzip,
    cacheMethod: 'none',
  });

  try {
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.AUTO,
      preserve_interword_spaces: '1',
    });
    const result = await worker.recognize(prepared);
    return {
      text: result.data.text.trim(),
      confidence: Number.isFinite(result.data.confidence) ? result.data.confidence / 100 : 0,
    };
  } finally {
    await worker.terminate();
  }
}
