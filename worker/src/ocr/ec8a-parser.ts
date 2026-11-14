// Turns OCR text of an EC8A sheet into figures with per-field confidence.
// The sheet prints each party's votes in figures and in words; when both are
// read and agree, confidence is high. Anything uncertain goes to the review
// queue, where staff type the figures while viewing the image.
//
// NOTE: tune the label patterns on real 2027 sheets once INEC releases them.

import type { ResultFigures } from '../../../shared/src/index.ts';

export interface OcrLine { text: string; confidence: number }   // confidence 0..1 from the provider

export interface ParsedSheet {
  figures: ResultFigures;
  confidence: Record<string, number>;   // field -> 0..1
  minConfidence: number;
  sheetPuCode: string | null;
  serialNo: string | null;
  missing: string[];
}

const HEADER_PATTERNS: [keyof Omit<ResultFigures, 'votes'>, RegExp][] = [
  ['registered', /(voters?\s+on\s+the\s+regist|registered\s+voters)/i],
  ['accredited', /accredited\s+voters/i],
  ['rejected', /rejected\s+ballots?/i],
  ['totalValid', /total\s+(number\s+of\s+)?valid\s+votes/i],
];

const SMALL: Record<string, number> = {
  zero: 0, nil: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** "one hundred and forty-nine" -> 149. Returns null if the words aren't a number. */
export function wordsToNumber(text: string): number | null {
  const words = text.toLowerCase().replace(/-/g, ' ').replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w && w !== 'and' && w !== 'only' && w !== 'votes');
  if (!words.length) return null;
  let total = 0, current = 0, any = false;
  for (const w of words) {
    if (w in SMALL) { current += SMALL[w]; any = true; }
    else if (w === 'hundred') { current = (current || 1) * 100; any = true; }
    else if (w === 'thousand') { total += (current || 1) * 1000; current = 0; any = true; }
    else return null;
  }
  return any ? total + current : null;
}

function firstInt(s: string): number | null {
  const m = /(\d[\d,\s]{0,7})/.exec(s.replace(/[oO](?=\d)|(?<=\d)[oO]/g, '0'));
  if (!m) return null;
  const n = Number(m[1].replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function parseEc8a(lines: OcrLine[], parties: string[]): ParsedSheet {
  const figures: ResultFigures = { registered: NaN, accredited: NaN, rejected: NaN, totalValid: NaN, votes: {} };
  const confidence: Record<string, number> = {};
  let sheetPuCode: string | null = null;
  let serialNo: string | null = null;
  const partySet = new Set(parties.map((p) => p.toUpperCase()));

  for (let i = 0; i < lines.length; i++) {
    const { text, confidence: c } = lines[i];
    const pu = /(\d{2})\s*[\/\-\s]\s*(\d{2})\s*[\/\-\s]\s*(\d{2})\s*[\/\-\s]\s*(\d{3})/.exec(text);
    if (pu && !sheetPuCode && /polling|unit|code|pu/i.test(text + (lines[i - 1]?.text ?? ''))) sheetPuCode = `${pu[1]}-${pu[2]}-${pu[3]}-${pu[4]}`;
    const sn = /serial\s*(no|number)?\.?\s*[:\-]?\s*([A-Z0-9]{5,12})/i.exec(text);
    if (sn && !serialNo) serialNo = sn[2];

    for (const [field, re] of HEADER_PATTERNS) {
      if (Number.isNaN(figures[field]) && re.test(text)) {
        // number on the same line after the label, else on the next line
        const after = text.replace(re, ' ').replace(/^[^\d]*/, '');
        const n = firstInt(after) ?? firstInt(lines[i + 1]?.text ?? '');
        if (n !== null) { figures[field] = n; confidence[field] = c; }
      }
    }

    // Party rows: "<sn> APC 83 EIGHTY THREE"
    const tokens = text.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
    const party = tokens.find((t) => partySet.has(t));
    if (party && !(party in figures.votes)) {
      const rest = text.slice(text.toUpperCase().indexOf(party) + party.length);
      const n = firstInt(rest);
      if (n !== null) {
        figures.votes[party] = n;
        const words = wordsToNumber(rest.replace(/[\d,]/g, ' '));
        // Figures and words agree -> strong; disagree -> weak; no words -> provider confidence
        confidence[`votes.${party}`] = words === null ? Math.min(c, 0.9) : words === n ? Math.max(c, 0.97) : Math.min(c, 0.4);
      }
    }
  }

  const missing: string[] = [];
  for (const [field] of HEADER_PATTERNS) if (Number.isNaN(figures[field])) { missing.push(field); figures[field] = 0; confidence[field] = 0; }
  for (const p of parties) if (!(p in figures.votes)) { missing.push(`votes.${p}`); }
  const minConfidence = Object.values(confidence).length ? Math.min(...Object.values(confidence)) : 0;
  return { figures, confidence, minConfidence: missing.length ? 0 : minConfidence, sheetPuCode, serialNo, missing };
}
