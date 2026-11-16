import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeResultSms, encodeIncidentSms, encodeCallbackSms, decodeSms, SmsDecodeError,
  checkResult, diffResults, normaliseNgPhone, normalisePuCode, areaAt,
  pointInGeometry, judgeCheckin, type Geo, type CheckinFence, placeName, figureFlags, usedBallots, type UnitFigures,
} from '../src/index.ts';

const figs = { registered: 607, accredited: 265, rejected: 0, totalValid: 265, votes: { APC: 83, NNPP: 149, PDP: 32, ADP: 1 } };

test('result SMS round-trips', () => {
  const sms = encodeResultSms({ puCode: '19-28-02-003', version: 2, agentCode: '7F3', ...figs });
  assert.match(sms, /^R1 19-28-02-003 V2 RG607 AC265 RJ0 TV265 APC83 NNPP149 PDP32 ADP1 K7F3 C\d\d$/);
  const d = decodeSms(sms);
  assert.equal(d.kind, 'result');
  if (d.kind === 'result') {
    assert.deepEqual(d.votes, figs.votes);
    assert.equal(d.registered, 607);
    assert.equal(d.agentCode, '7F3');
  }
});

test('altered SMS fails checksum', () => {
  const sms = encodeResultSms({ puCode: '19-28-02-003', version: 1, agentCode: '7F3', ...figs });
  assert.throws(() => decodeSms(sms.replace('APC83', 'APC93')), SmsDecodeError);
});

test('incident and callback SMS round-trip', () => {
  const i = decodeSms(encodeIncidentSms({ puCode: '20-01-03-010', category: 'bvas_failure', severity: 'high', agentCode: 'AB12' }));
  assert.deepEqual(i, { kind: 'incident', puCode: '20-01-03-010', category: 'bvas_failure', severity: 'high', agentCode: 'AB12' });
  const c = decodeSms(encodeCallbackSms({ reason: 'unit', agentCode: 'AB12' }));
  assert.deepEqual(c, { kind: 'callback', reason: 'unit', agentCode: 'AB12' });
});

test('decoding tolerates case and spacing', () => {
  const sms = encodeCallbackSms({ reason: 'form', agentCode: 'Z9Z9' });
  assert.equal(decodeSms('  ' + sms.toLowerCase().replace(/ /g, '   ')).kind, 'callback');
});

test('result checks', () => {
  assert.deepEqual(checkResult(figs), []);
  const bad = checkResult({ ...figs, totalValid: 300 });
  assert.ok(bad.some((x) => x.code === 'sum_mismatch'));
  assert.ok(bad.some((x) => x.code === 'over_accredited'));
  assert.deepEqual(diffResults(figs, { ...figs, votes: { ...figs.votes, PDP: 33 } }), ['votes.PDP']);
});

test('phone and pu code normalisation', () => {
  assert.equal(normaliseNgPhone('0803 123 4567'), '+2348031234567');
  assert.equal(normaliseNgPhone('+234 803 123 4567'), '+2348031234567');
  assert.equal(normaliseNgPhone('12345'), null);
  assert.equal(normalisePuCode('19/28/02/003'), '19-28-02-003');
  assert.equal(areaAt('19-28-02-003', 'lga'), '19-28');
});

test('map colours: issues, parties, reporting', async () => {
  const { issueBand, partyColour, leadOpacity, reportingBand } = await import('../src/index.ts');
  const none = { open: 0, critical: 0, high: 0, medium: 0, low: 0 };
  assert.equal(issueBand(none), 0);
  assert.equal(issueBand({ ...none, open: 2, low: 2 }), 1);
  assert.equal(issueBand({ ...none, open: 2, high: 2 }), 2);
  assert.equal(issueBand({ ...none, open: 3, high: 3 }), 3);
  assert.equal(issueBand({ ...none, open: 1, critical: 1 }), 4);
  const order = ['APC', 'PDP', 'LP'];
  assert.notEqual(partyColour('APC', order), partyColour('PDP', order));
  assert.equal(partyColour('APC', order, { APC: '#123456' }), '#123456');
  assert.equal(partyColour('XYZ', order), partyColour('XYZ', order));
  assert.ok(leadOpacity(0) < leadOpacity(0.2) && leadOpacity(1) <= 0.9);
  assert.deepEqual([reportingBand(0, 10), reportingBand(1, 10), reportingBand(3, 10), reportingBand(6, 10), reportingBand(10, 10)], [0, 1, 2, 3, 4]);
});

test('check-in location: inside the ward, near the unit, or not', () => {
  const square: Geo = { type: 'Polygon', coordinates: [[[8, 12], [8.1, 12], [8.1, 12.1], [8, 12.1], [8, 12]]] };
  assert.equal(pointInGeometry(12.05, 8.05, square), true);
  assert.equal(pointInGeometry(12.2, 8.05, square), false);
  const ward: CheckinFence = { level: 'ward', code: '19-28-02', name: 'W', geometry: square, center: { lat: 12.05, lng: 8.05 } };
  assert.equal(judgeCheckin(ward, { lat: 12.05, lng: 8.05 }).inside, true);
  const out = judgeCheckin(ward, { lat: 12.3, lng: 8.05 });
  assert.equal(out.inside, false);
  assert.ok(out.distance! > 20000);
  assert.equal(judgeCheckin(ward, {}).inside, null);
  const unit: CheckinFence = { level: 'unit', code: '19-28-02-003', name: 'U', center: { lat: 12, lng: 8 } };
  assert.equal(judgeCheckin(unit, { lat: 12.005, lng: 8 }).inside, true);   // ~550 m
  assert.equal(judgeCheckin(unit, { lat: 12.03, lng: 8 }).inside, false);   // ~3.3 km
  assert.equal(judgeCheckin(null, { lat: 1, lng: 1 }).inside, null);
});

test('place names read well', () => {
  assert.equal(placeName('TUDUN WADA'), 'Tudun Wada');
  assert.equal(placeName('Tinde Laru Ii'), 'Tinde Laru II');
  assert.equal(placeName('LGEA PRI. SCH. KOFAR FADA'), 'LGEA Pri. Sch. Kofar Fada');
  assert.equal(placeName('Botta / Botta'), 'Botta / Botta');
  assert.equal(placeName('FEDERAL CAPITAL TERRITORY'), 'Federal Capital Territory');
  assert.equal(placeName("  DAN'AGUNDI  "), "Dan'agundi");
  assert.equal(placeName(null), '');
});

test('polling-day figures: flags for impossible figures, unbalanced ballots and turnout', () => {
  const flags = (f: UnitFigures, o?: Parameters<typeof figureFlags>[1]) => figureFlags(f, o).map((x) => x.flag);
  assert.deepEqual(flags({ registered: 650, accredited: 700 }), ['over_registered']);
  assert.deepEqual(flags({ registered: 650, ballots_received: 650, accredited: 300, unused: 350, spoiled: 2, rejected: 8, total_valid: 290 }), []);
  assert.equal(usedBallots({ spoiled: 2, rejected: 8, total_valid: 290 }), 300);
  assert.deepEqual(flags({ ballots_received: 650, unused: 300, spoiled: 2, rejected: 8, total_valid: 290 }), ['ballots_unbalanced']);
  assert.deepEqual(flags({ spoiled: 2, rejected: 8, total_valid: 290, used: 310 }), ['used_mismatch']);
  assert.deepEqual(flags({ accredited: 280, rejected: 8, total_valid: 290 }), ['over_accredited']);
  assert.deepEqual(flags({ accredited: 150 }, { previousAccredited: 180 }), ['accreditation_dropped']);
  // Turnout flags only once accreditation has closed
  assert.deepEqual(flags({ registered: 600, accredited: 40 }), []);
  assert.deepEqual(flags({ registered: 600, accredited: 40 }, { final: true }), ['low_turnout']);
  assert.deepEqual(flags({ registered: 600, accredited: 580 }, { final: true }), ['very_high_turnout']);
  assert.deepEqual(flags({ registered: 600, accredited: 120 }, { final: true, baseline: { turnout: 0.5, ownShare: 0.7 } }), ['stronghold_low_turnout']);
  assert.deepEqual(flags({ registered: 600, accredited: 120 }, { final: true, baseline: { turnout: 0.5, ownShare: 0.3 } }), []);
  assert.deepEqual(flags({ registered: 30, accredited: 1 }, { final: true }), []); // tiny units are not judged on turnout
});
