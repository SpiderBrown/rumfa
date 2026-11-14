import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeResultSms, encodeIncidentSms, encodeCallbackSms, decodeSms, SmsDecodeError,
  checkResult, diffResults, normaliseNgPhone, normalisePuCode, areaAt,
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
