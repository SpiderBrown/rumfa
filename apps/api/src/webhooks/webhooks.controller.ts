import { Body, Controller, Get, Header, HttpCode, Logger, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { createHash, createHmac } from 'node:crypto';
import { Public } from '../auth/decorators';
import { safeEqual } from '../auth/crypto';
import type { AppConfig } from '../config/configuration';
import { Db } from '../database/db.service';
import { ProvidersService } from '../common/providers.service';
import { StorageService } from '../common/storage.service';
import { decodeSms, normaliseNgPhone, SmsDecodeError } from '../shared';

const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<Response>${body}</Response>`;
const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

async function rawBody(req: Request & { rawBody?: Buffer }): Promise<Buffer> {
  if (req.rawBody) return req.rawBody;
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Provider callbacks. Every URL carries ?key=WEBHOOK_KEY; providers that sign requests are also checked by
 * signature. These run as the database owner (system context): each handler decides itself what it may touch.
 */
@ApiExcludeController()
@Public()
@SkipThrottle()
@Controller('webhooks')
export class WebhooksController {
  private readonly log = new Logger('Webhooks');

  constructor(private readonly db: Db, private readonly config: ConfigService, private readonly providers: ProvidersService,
              private readonly storage: StorageService) {}

  private key(k: string | undefined) {
    const expected = this.config.get<string>('webhookKey') ?? '';
    if (!expected || !k || !safeEqual(k, expected)) throw new UnauthorizedException('Bad webhook key');
  }

  // ---- Coded SMS fallback (results, incidents, callback requests) ----------------------------------
  @Post('at/sms') @HttpCode(200)
  async sms(@Query('key') key: string, @Body() f: Record<string, string>) {
    this.key(key);
    const from = normaliseNgPhone(f.from ?? '');
    const text = f.text ?? '';
    let logId: string;
    try {
      [{ id: logId }] = await this.db.system(
        `insert into public.sms_inbound (provider_id, from_phone, to_number, text) values ($1, $2, $3, $4) returning id`,
        [f.id ?? null, f.from ?? '', f.to ?? null, text]);
    } catch (e: any) {
      if (e?.status === 409 || e?.getStatus?.() === 409) return { ok: true, duplicate: true }; // provider retry
      throw e;
    }
    const finish = async (patch: { decoded?: unknown; error?: string; tenant_id?: string; volunteer_id?: string }, reply?: string) => {
      await this.db.system(
        `update public.sms_inbound set decoded = $2, error = $3, tenant_id = $4, volunteer_id = $5, processed_at = now() where id = $1`,
        [logId, patch.decoded ? JSON.stringify(patch.decoded) : null, patch.error ?? null, patch.tenant_id ?? null, patch.volunteer_id ?? null]);
      if (reply && from && patch.tenant_id) {
        await this.db.system(`insert into public.outbox (channel, to_phone, template, data, tenant_id) values ('sms', $1, 'raw', $2, $3)`,
          [from, JSON.stringify({ text: reply }), patch.tenant_id]);
      }
      return { ok: true };
    };
    if (!from) return finish({ error: 'Sender is not a Nigerian mobile number' });

    let msg: ReturnType<typeof decodeSms>;
    try {
      msg = decodeSms(text);
    } catch (e) {
      const reason = e instanceof SmsDecodeError ? e.message : 'Unreadable';
      // Registered senders get a reply in their client's name; strangers get none
      const [known] = await this.db.system(`select tenant_id from public.volunteers where phone = $1 and status = 'active' limit 1`, [from]);
      return finish({ error: reason, tenant_id: known?.tenant_id }, 'Message not accepted. Please resend from the app.');
    }
    // The agent code decides the client: it is unique across every client the phone works for
    const [v] = await this.db.system(
      `select id, tenant_id from public.volunteers where phone = $1 and status = 'active' and agent_code = $2`, [from, msg.agentCode]);
    if (!v) return finish({ decoded: msg, error: 'Unknown sender or agent code' });
    const base = { decoded: msg, tenant_id: v.tenant_id, volunteer_id: v.id };
    try {
      if (msg.kind === 'result') {
        const [{ r }] = await this.db.system(
          `select public.svc_ingest_result(p_volunteer => $1, p_pu => $2, p_registered => $3, p_accredited => $4, p_rejected => $5,
                  p_total_valid => $6, p_votes => $7, p_source => 'sms', p_client_id => null) as r`,
          [v.id, msg.puCode, msg.registered, msg.accredited, msg.rejected, msg.totalValid, JSON.stringify(msg.votes)]);
        return finish(base, `Result for ${msg.puCode} received (ref ${String(r.submission_id).slice(0, 8)}).`);
      }
      if (msg.kind === 'incident') {
        await this.db.system(
          `select public.svc_ingest_incident(p_volunteer => $1, p_pu => $2, p_category => $3, p_severity => $4,
                  p_description => 'Sent by SMS', p_source => 'sms', p_client_id => null)`,
          [v.id, msg.puCode, msg.category, msg.severity]);
        return finish(base, `Report for ${msg.puCode} received. The situation room will call you.`);
      }
      await this.db.system(`select public.svc_ingest_callback(p_volunteer => $1, p_reason => $2, p_channel => 'sms')`, [v.id, msg.reason]);
      return finish(base, 'Your coordinator will call you shortly.');
    } catch (e) {
      return finish({ ...base, error: (e as Error).message }, 'Message could not be processed. Please call your coordinator.');
    }
  }

  // ---- Voice: bridged calls, dashboard calls, outreach playback and opt-out -------------------------
  @Post('at/voice') @HttpCode(200) @Header('Content-Type', 'application/xml')
  async voice(@Query() qs: Record<string, string>, @Body() f: Record<string, string>): Promise<string> {
    this.key(qs.key);
    const at = this.config.get<AppConfig['at']>('at')!;
    const sessionId = f.sessionId ?? '';

    if (qs.step === 'dtmf') {
      if (f.dtmfDigits === '9' && qs.attempt) {
        const [a] = await this.db.system(
          `select a.id, c.phone from public.voice_call_attempts a join public.voice_contacts c on c.id = a.contact_id where a.id = $1`, [qs.attempt]);
        if (a) {
          await this.db.system(`insert into public.voice_opt_outs (phone, source) values ($1, 'dtmf') on conflict (phone) do nothing`, [a.phone]);
          await this.db.system(`update public.voice_call_attempts set status = 'opted_out', dtmf = '9', updated_at = now() where id = $1`, [a.id]);
        }
        return xml('<Say>You will not receive these calls again. Goodbye.</Say>');
      }
      return xml('');
    }

    if (f.isActive === '0') {
      const duration = Number(f.durationInSeconds ?? 0) || 0;
      const answered = duration > 0 && (f.status ?? '').toLowerCase() === 'success';
      const status = answered ? 'completed' : (f.hangupCause ?? '').toLowerCase().includes('busy') ? 'busy' : 'no_answer';
      const [call] = await this.db.system(`select id, contact_id from public.calls where provider_session_id = $1`, [sessionId]);
      if (call) {
        await this.db.system(`update public.calls set status = $2, duration_s = $3, recording_url = $4, ended_at = now() where id = $1`,
          [call.id, status, duration, f.recordingUrl ?? null]);
        if (call.contact_id) await this.db.system(`select public.svc_contact_call_result($1, $2)`, [call.contact_id, answered]);
        return xml('');
      }
      await this.db.system(
        `update public.voice_call_attempts set status = $2, duration_s = $3, updated_at = now()
          where provider_session_id = $1 and status <> 'opted_out'`, [sessionId, status, duration]);
      return xml('');
    }

    // 1. Bridged call: first person answered, now ring the second
    let [call] = await this.db.system(`select id, to_phone, route from public.calls where provider_session_id = $1`, [sessionId]);
    if (!call && /^[0-9a-f-]{36}$/.test(f.clientRequestId ?? '')) {
      [call] = await this.db.system(
        `update public.calls set provider_session_id = $2 where id = $1 and provider_session_id is null returning id, to_phone, route`,
        [f.clientRequestId, sessionId]);
    }
    if (call?.route === 'bridged') {
      await this.db.system(`update public.calls set status = 'answered' where id = $1`, [call.id]);
      return xml(`<Say>Connecting you now.</Say><Dial phoneNumbers="${esc(call.to_phone)}" record="true" callerId="${esc(at.voiceNumber)}" sequential="true"/>`);
    }

    // 2. Voice outreach: play the approved recording in the contact's language, offer opt-out
    const [att] = await this.db.system(
      `select a.id, c.recordings, vc.language from public.voice_call_attempts a
         join public.voice_campaigns c on c.id = a.campaign_id join public.voice_contacts vc on vc.id = a.contact_id
        where a.provider_session_id = $1`, [sessionId]);
    if (att) {
      const recId = att.recordings[att.language] ?? Object.values(att.recordings)[0];
      const [rec] = await this.db.system(`select storage_path, status from public.voice_recordings where id = $1`, [recId]);
      if (!rec || rec.status !== 'approved') return xml('<Reject/>');
      const url = await this.storage.viewUrl('voice-recordings', rec.storage_path, 600);
      await this.db.system(`update public.voice_call_attempts set status = 'answered', updated_at = now() where id = $1`, [att.id]);
      const cb = `${this.config.get('publicUrl')}/api/v1/webhooks/at/voice?key=${encodeURIComponent(qs.key)}&step=dtmf&attempt=${att.id}`;
      return xml(`<Play url="${esc(url)}"/><GetDigits timeout="8" numDigits="1" callbackUrl="${esc(cb)}"><Say>To stop receiving these calls, press 9.</Say></GetDigits>`);
    }

    // 3. Browser call from a dashboard operator: only numbers registered through /calls/prepare in the last 3 minutes
    const dest = normaliseNgPhone(f.clientDialedNumber ?? f.destinationNumber ?? '');
    if (dest && (f.callerNumber ?? '').includes('.v')) {
      const [pending] = await this.db.system(
        `update public.calls set provider_session_id = $2, status = 'ringing'
          where id = (select id from public.calls where route = 'webrtc_pstn' and status = 'initiated' and to_phone = $1
                         and started_at > now() - interval '3 minutes' order by started_at desc limit 1)
          returning id`, [dest, sessionId]);
      if (pending) return xml(`<Dial phoneNumbers="${esc(dest)}" record="true" callerId="${esc(at.voiceNumber)}"/>`);
    }
    return xml('<Say>Thank you for calling. Please use the app or call your coordinator.</Say>');
  }

  // ---- WhatsApp delivery statuses ---------------------------------------------------------------------
  @Get('whatsapp')
  verifyWhatsApp(@Query() qs: Record<string, string>) {
    const wa = this.config.get<AppConfig['whatsapp']>('whatsapp')!;
    if (qs['hub.mode'] === 'subscribe' && wa.verifyToken && safeEqual(qs['hub.verify_token'] ?? '', wa.verifyToken)) return qs['hub.challenge'];
    throw new UnauthorizedException();
  }

  @Post('whatsapp') @HttpCode(200)
  async whatsapp(@Query('key') key: string, @Req() req: Request) {
    this.key(key);
    const secret = this.config.get<AppConfig['whatsapp']>('whatsapp')!.appSecret;
    const sig = String(req.headers['x-hub-signature-256'] ?? '');
    const expected = 'sha256=' + createHmac('sha256', secret).update(await rawBody(req)).digest('hex');
    if (!secret || !safeEqual(sig, expected)) throw new UnauthorizedException('Bad signature');
    const statuses = (req.body?.entry ?? []).flatMap((e: any) => e.changes ?? []).flatMap((c: any) => c.value?.statuses ?? []);
    for (const s of statuses) if (s.status === 'failed') this.log.warn(`WhatsApp message ${s.id} to ${s.recipient_id} failed: ${JSON.stringify(s.errors ?? [])}`);
    return { ok: true };
  }

  // ---- VTpass top-up results: never trusted as sent; confirmed by asking VTpass -------------------------
  @Post('vtpass') @HttpCode(200)
  async vtpass(@Query('key') key: string, @Body() b: any) {
    this.key(key);
    const requestId = String(b?.data?.requestId ?? b?.requestId ?? b?.data?.request_id ?? '');
    if (!/^[A-Za-z0-9_-]{6,60}$/.test(requestId)) return { response: 'success' };
    const [t] = await this.db.system(`select id, status from public.topups where provider = 'vtpass' and provider_ref = $1`, [requestId]);
    if (!t || t.status !== 'pending') return { response: 'success' };
    const vt = this.config.get<AppConfig['vtpass']>('vtpass')!;
    try {
      const res = await fetch(`${vt.baseUrl}/requery`, {
        method: 'POST', headers: { 'api-key': vt.apiKey, 'secret-key': vt.secretKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_id: requestId }),
      });
      const j: any = await res.json();
      const st = String(j?.content?.transactions?.status ?? '').toLowerCase();
      const status = st === 'delivered' ? 'success' : ['failed', 'reversed'].includes(st) ? 'failed' : null;
      if (status) await this.db.system(`update public.topups set status = $2, updated_at = now() where id = $1 and status = 'pending'`, [t.id, status]);
    } catch (e) {
      this.log.warn(`VTpass requery failed for ${requestId}: ${(e as Error).message}`); // the worker re-checks pending top-ups anyway
    }
    return { response: 'success' };
  }

  // ---- LiveKit room events --------------------------------------------------------------------------
  @Post('livekit') @HttpCode(200)
  async livekit(@Query('key') key: string, @Req() req: Request) {
    this.key(key);
    const body = await rawBody(req);
    let claims: any;
    try { claims = this.providers.verifyLivekitWebhook(req.headers.authorization); } catch { throw new UnauthorizedException('Bad signature'); }
    if (claims.sha256 !== createHash('sha256').update(body).digest('base64')) throw new UnauthorizedException('Bad signature');
    const event = JSON.parse(body.toString('utf8') || '{}');
    if (event.event === 'room_finished' && event.room?.name) {
      await this.db.system(
        `update public.live_view_requests set status = 'ended', ended_at = coalesce(ended_at, now())
          where room_name = $1 and status in ('accepted','live')`, [event.room.name]);
    }
    // App calls (rooms "call-<id>"): when someone drops out (app closed, phone died) the call ends for both,
    // so nobody is left showing as busy. Only answered calls; a ringing caller waits for the ring time.
    const callId = /^call-([0-9a-f-]{36})$/.exec(event.room?.name ?? '')?.[1];
    if (callId && (event.event === 'participant_left' || event.event === 'room_finished')) {
      await this.db.system(
        `update public.calls set status = 'completed', ended_at = now(), duration_s = greatest(0, extract(epoch from now() - started_at))::int
          where id = $1 and route = 'inapp' and status = 'answered'`, [callId]);
    }
    return { ok: true };
  }
}
