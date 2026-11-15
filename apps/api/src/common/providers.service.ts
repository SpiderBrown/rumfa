import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { AppConfig } from '../config/configuration';

/** Outbound calls to Africa's Talking voice and LiveKit tokens. */
@Injectable()
export class ProvidersService {
  constructor(private readonly config: ConfigService, private readonly jwt: JwtService) {}

  private get at() { return this.config.get<AppConfig['at']>('at')!; }
  private get lk() { return this.config.get<AppConfig['livekit']>('livekit')!; }

  /** Rings `to` from our voice number; when answered, the voice webhook connects the second leg. */
  async atMakeCall(to: string, clientRequestId: string): Promise<string | null> {
    this.voiceReady();
    const res = await this.reach('https://voice.africastalking.com/call', {
      method: 'POST',
      headers: { apiKey: this.at.apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: this.at.username, from: this.at.voiceNumber, to, clientRequestId }),
    });
    if (!res.ok) throw new ServiceUnavailableException(`Call failed (${res.status})`);
    const entry = (await res.json())?.entries?.[0];
    if (entry?.status !== 'Queued') throw new ServiceUnavailableException(`Call was not queued${entry?.status ? ` (${entry.status})` : ''}`);
    return entry.sessionId ?? null;
  }

  /**
   * Africa's Talking voice (calls and internet calling) has no sandbox: it needs a live app with a voice number.
   * Fails with a clear message instead of an unreachable host.
   */
  private voiceReady() {
    if (this.at.username === 'sandbox' || !this.at.apiKey) {
      throw new ServiceUnavailableException("Calls through Rumfa need a live Africa's Talking account (voice has no sandbox). Set AT_USERNAME and AT_API_KEY for the live app.");
    }
    if (!this.at.voiceNumber) throw new ServiceUnavailableException('Calls through Rumfa need a voice number: set AT_VOICE_NUMBER.');
  }

  /** fetch, with an unreachable provider reported as 503 rather than a server error. */
  private async reach(url: string, init: RequestInit): Promise<Response> {
    try { return await fetch(url, init); } catch { throw new ServiceUnavailableException("Could not reach Africa's Talking. Check the server's internet connection."); }
  }

  /** WebRTC capability token for a browser operator (outgoing calls only). */
  async atCapabilityToken(clientName: string): Promise<{ token: string; lifeTimeSec: string }> {
    this.voiceReady();
    const res = await this.reach('https://webrtc.africastalking.com/capability-token/request', {
      method: 'POST',
      headers: { apiKey: this.at.apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.at.username, clientName, phoneNumber: this.at.voiceNumber, incoming: 'false', outgoing: 'true', expire: '3600s' }),
    });
    if (!res.ok) throw new ServiceUnavailableException(`Calling token failed (${res.status})`);
    return res.json() as any;
  }

  livekitUrl() { return this.lk.url; }

  /** LiveKit is needed for live video and app calls. */
  livekitReady() {
    if (!this.lk.url || !this.lk.apiKey || !this.lk.apiSecret) {
      throw new ServiceUnavailableException('App calls need LiveKit: set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET.');
    }
  }

  /** Token for a two-way voice call: microphone only, hears the other person. */
  livekitCallToken(identity: string, name: string, room: string, ttlSec = 7200): string {
    return this.jwt.sign(
      { name, video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false, canPublishSources: ['microphone'] } },
      { secret: this.lk.apiSecret, issuer: this.lk.apiKey, subject: identity, expiresIn: ttlSec, notBefore: -10, algorithm: 'HS256' },
    );
  }

  livekitToken(identity: string, name: string, room: string, canPublish: boolean, ttlSec = 1800): string {
    return this.jwt.sign(
      { name, video: { room, roomJoin: true, canPublish, canSubscribe: !canPublish, canPublishData: false, canPublishSources: canPublish ? ['camera', 'microphone'] : [] } },
      { secret: this.lk.apiSecret, issuer: this.lk.apiKey, subject: identity, expiresIn: ttlSec, notBefore: -10, algorithm: 'HS256' },
    );
  }

  verifyLivekitWebhook(authHeader: string | undefined): any {
    return this.jwt.verify(authHeader ?? '', { secret: this.lk.apiSecret, issuer: this.lk.apiKey, algorithms: ['HS256'] });
  }
}
