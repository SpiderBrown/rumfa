// OCR providers. The choice is open until the accuracy test on 200 real 2023
// sheets; 'manual' sends every sheet to the review queue (no OCR cost).

import { config } from '../config.ts';
import type { OcrLine } from './ec8a-parser.ts';

export interface OcrProvider { name: string; read(bytes: Buffer, contentType: string): Promise<OcrLine[]> }

const manual: OcrProvider = { name: 'manual', async read() { return []; } };

// Google Cloud Vision: DOCUMENT_TEXT_DETECTION (images). PDFs need the async
// files API; store PDFs as images first or use Azure.
const google: OcrProvider = {
  name: 'google',
  async read(bytes, contentType) {
    if (contentType.includes('pdf')) throw new Error('Google Vision sync API does not take PDFs');
    const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${config.ocr.googleApiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ image: { content: bytes.toString('base64') }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }] }] }),
    });
    if (!res.ok) throw new Error(`Vision ${res.status}: ${await res.text()}`);
    const body = await res.json() as any;
    const pages = body.responses?.[0]?.fullTextAnnotation?.pages ?? [];
    const lines: OcrLine[] = [];
    for (const p of pages) for (const b of p.blocks ?? []) for (const para of b.paragraphs ?? []) {
      const words = (para.words ?? []).map((w: any) => ({
        text: (w.symbols ?? []).map((s: any) => s.text).join(''), confidence: w.confidence ?? 0.5,
      }));
      if (words.length) lines.push({ text: words.map((w: any) => w.text).join(' '), confidence: Math.min(...words.map((w: any) => w.confidence)) });
    }
    return lines;
  },
};

// Azure AI Document Intelligence, prebuilt-read (images and PDFs).
const azure: OcrProvider = {
  name: 'azure',
  async read(bytes, contentType) {
    const url = `${config.ocr.azureEndpoint.replace(/\/$/, '')}/documentintelligence/documentModels/prebuilt-read:analyze?api-version=2024-11-30`;
    const start = await fetch(url, {
      method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': config.ocr.azureKey, 'Content-Type': contentType || 'application/octet-stream' },
      body: bytes,
    });
    if (start.status !== 202) throw new Error(`Azure ${start.status}: ${await start.text()}`);
    const op = start.headers.get('operation-location')!;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const r = await fetch(op, { headers: { 'Ocp-Apim-Subscription-Key': config.ocr.azureKey } });
      const j = await r.json() as any;
      if (j.status === 'succeeded') {
        const lines: OcrLine[] = [];
        for (const page of j.analyzeResult?.pages ?? []) {
          const words = page.words ?? [];
          for (const line of page.lines ?? []) {
            const span = line.spans?.[0];
            const ws = words.filter((w: any) => span && w.span.offset >= span.offset && w.span.offset < span.offset + span.length);
            lines.push({ text: line.content, confidence: ws.length ? Math.min(...ws.map((w: any) => w.confidence)) : 0.5 });
          }
        }
        return lines;
      }
      if (j.status === 'failed') throw new Error('Azure analysis failed');
    }
    throw new Error('Azure analysis timed out');
  },
};

export function ocrProvider(): OcrProvider {
  switch (config.ocr.provider) {
    case 'google': return google;
    case 'azure': return azure;
    default: return manual;
  }
}
