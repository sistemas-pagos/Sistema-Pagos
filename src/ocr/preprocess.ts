import sharp from 'sharp';

const MAX_OCR_WIDTH = 1800;

export async function preprocessReceiptForOcr(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes, { failOn: 'warning' })
    .rotate()
    .resize({ width: MAX_OCR_WIDTH, withoutEnlargement: true })
    .grayscale()
    .normalize()
    .sharpen({ sigma: 0.8 })
    .png({ compressionLevel: 6 })
    .toBuffer();
}
