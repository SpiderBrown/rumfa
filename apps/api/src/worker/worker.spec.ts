// Unit tests for the worker's pure parts (no database): OCR parsing, CSV, trend rule, provider helpers,
// duplicate-sheet hashing on real 2023 IReV samples, and message templates.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseCsv } from '../scripts/csv';
import { documentUrls, puCodeFromIrev } from './irev/client';
import { DUPLICATE_MAX_DISTANCE, hamming, prepareSheet } from './irev/image';
import { render } from './notify/outbox';
import { parseEc8a, wordsToNumber } from './ocr/ec8a-parser';
import { outliers } from './rules/trend';
import { vtRequestId } from './topups/send';
import { lagosMinutes } from './voice/dialer';

const SAMPLES = resolve(__dirname, '../../../../samples');

test('words to number', () => {
  assert.equal(wordsToNumber('one hundred and forty-nine'), 149);
  assert.equal(wordsToNumber('EIGHTY THREE'), 83);
  assert.equal(wordsToNumber('two thousand three hundred'), 2300);
  assert.equal(wordsToNumber('nil'), 0);
  assert.equal(wordsToNumber('APC'), null);
});

test('EC8A parser reads header, parties and cross-checks words', () => {
  const lines = [
    { text: 'Polling Unit Code: 19/28/02/003', confidence: 0.99 },
    { text: 'Number of Voters on the Register 607', confidence: 0.98 },
    { text: 'Number of Accredited Voters 265', confidence: 0.97 },
    { text: 'Number of Rejected Ballots 0', confidence: 0.96 },
    { text: 'Total Number of Valid Votes 265', confidence: 0.95 },
    { text: '1 APC 83 Eighty three', confidence: 0.9 },
    { text: '2 NNPP 149 one hundred and forty nine', confidence: 0.9 },
    { text: '3 PDP 32 thirty two', confidence: 0.9 },
    { text: '4 ADP 1 one', confidence: 0.9 },
  ];
  const p = parseEc8a(lines, ['APC', 'NNPP', 'PDP', 'ADP']);
  assert.equal(p.sheetPuCode, '19-28-02-003');
  assert.deepEqual(p.figures, { registered: 607, accredited: 265, rejected: 0, totalValid: 265, votes: { APC: 83, NNPP: 149, PDP: 32, ADP: 1 } });
  assert.deepEqual(p.missing, []);
  assert.ok(p.confidence['votes.APC'] >= 0.97, 'words agree -> high confidence');
  assert.ok(p.minConfidence >= 0.9);
});

test('EC8A parser lowers confidence when figures and words disagree', () => {
  const p = parseEc8a([{ text: 'APC 93 eighty three', confidence: 0.95 }], ['APC']);
  assert.ok(p.confidence['votes.APC'] <= 0.4);
  assert.ok(p.missing.includes('registered'));
  assert.equal(p.minConfidence, 0);
});

test('CSV parser handles quotes and headers', () => {
  const rows = parseCsv('Full Name,Phone,Area Code\n"Musa, Ali",0803 123 4567,19/28/02/003\r\n"Said ""Big""",08031234568,\n');
  assert.deepEqual(rows, [
    { full_name: 'Musa, Ali', phone: '0803 123 4567', area_code: '19/28/02/003' },
    { full_name: 'Said "Big"', phone: '08031234568', area_code: '' },
  ]);
});

test('trend outliers flag units that swing far from their LGA', () => {
  const units = ['001', '002', '003', '004', '005', '006'].map((n, i) => ({ pu: `19-28-02-${n}`, before: 0.4, now: i === 5 ? 0.95 : 0.45 }));
  const o = outliers(units);
  assert.deepEqual(o.map((x) => x.pu), ['19-28-02-006']);
});

test('VTpass request id starts with Lagos time stamp', () => {
  const id = vtRequestId('tu-abc-123', new Date('2027-01-15T23:30:00Z'));
  assert.ok(id.startsWith('202701160030'), id);
});

test('IReV helpers', () => {
  assert.equal(puCodeFromIrev('19/28/02/003'), '19-28-02-003');
  assert.deepEqual(documentUrls({ url: 'https://x/cached/results/1/r_thumb.jpg' }), ['https://x/cached/results/1/r_thumb.jpg', 'https://x/cached/results/1/r.jpg']);
  assert.deepEqual(documentUrls({ url: 'https://docs.inecelectionresults.net/a.pdf', document_url: 'https://spaces/a.pdf', backup_url: 'https://b/a.pdf' }),
    ['https://spaces/a.pdf', 'https://b/a.pdf']);
});

test('real IReV sheets: duplicate uploads detected, different sheets kept apart', async () => {
  // 19-28-02-003 and 19-28-02-005 on IReV (2023) carry the same photo of one sheet,
  // re-encoded (different bytes). 18-16-01-013 is a different sheet.
  const load = (f: string) => prepareSheet(readFileSync(join(SAMPLES, f)), 'image/jpeg', 1024);
  const a = await load('ec8a_19-28-02-003_thumb.jpg');
  const dup = await load('ec8a_19-28-02-005_thumb.jpg');
  const other = await load('ec8a_18-16-01-013_thumb.jpg');
  const pdf = await prepareSheet(readFileSync(join(SAMPLES, 'ec8a_18-16-01-018.pdf')), 'application/pdf', 1024);
  assert.equal(a.ext, 'jpg');
  assert.equal(pdf.ext, 'pdf');
  assert.notEqual(a.sha256, dup.sha256, 'bytes differ');
  assert.ok(hamming(a.phash!, dup.phash!) <= DUPLICATE_MAX_DISTANCE, 'same sheet detected despite different bytes');
  assert.ok(hamming(a.phash!, other.phash!) > DUPLICATE_MAX_DISTANCE * 2, 'different sheet not flagged');
});

test('Lagos time and templates', () => {
  assert.equal(lagosMinutes(new Date('2027-01-16T07:30:00Z')), 8 * 60 + 30);
  assert.match(render('callback_request_sms', { name: 'Musa', phone: '+2348031234567', reason: 'unit' }).body, /Musa .*problem at the unit/);
  assert.match(render('raw', { text: 'hello' }, 'ALAWA').body, /^ALAWA: hello$/);
  assert.match(render('raw', { text: 'hello' }).body, /^Rumfa: hello$/);
});
