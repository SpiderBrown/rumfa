import { Injectable, computed, inject, signal } from '@angular/core';
import { Network } from '@capacitor/network';
import { encodeCallbackSms, encodeIncidentSms, encodeResultSms, type Severity } from '@rumfa/shared';
import { Api, ApiError } from './api';

/**
 * Offline-first queue. Every report is saved on the phone first (IndexedDB),
 * then sent when there is signal. Results, incidents and callback requests can
 * also go by SMS: the app builds the coded message from the saved form, so the
 * agent never types it.
 */
export type ItemKind = 'incident' | 'result' | 'callback' | 'checkin' | 'checklist' | 'quick' | 'message' | 'figures';
export interface OutItem {
  id: string;                 // client_id, makes server writes idempotent
  kind: ItemKind;
  payload: Record<string, any>;
  photo?: Blob | null;        // EC8A photo or incident photo
  createdAt: number;
  status: 'waiting' | 'sending' | 'sent' | 'failed';
  error?: string;
  smsSentAt?: number;
  label: string;              // shown in the "Waiting to send" list
  tenantId?: string;          // the organisation it was made for (people may work for several)
  memberId?: string;          // who made it: the person's membership in that organisation
  agentCode?: string | null;  // that organisation's agent code, used in the SMS fallback
}

const DB = 'rumfa-outbox';
const STORE = 'items';
const SMS_OFFER_AFTER_MS = 2 * 60_000;

function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await idb();
  return new Promise((res, rej) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

@Injectable({ providedIn: 'root' })
export class Outbox {
  private api = inject(Api);
  /** Everything stored on this phone, for every person and organisation that has signed in here. */
  private readonly all = signal<OutItem[]>([]);
  /** Only the signed-in person's items, for the organisation they are signed in to now. Others stay stored until that person signs back in. */
  readonly items = computed(() => {
    const me = this.api.me();
    return me ? this.all().filter((i) => i.memberId === me.id && i.tenantId === me.tenant_id) : [];
  });
  readonly online = signal(true);
  readonly pending = computed(() => this.items().filter((i) => i.status !== 'sent'));
  private syncing = false;

  async init() {
    await this.reload();
    const st = await Network.getStatus().catch(() => ({ connected: navigator.onLine }));
    this.online.set(st.connected);
    void Network.addListener('networkStatusChange', (s) => { this.online.set(s.connected); if (s.connected) void this.sync(); });
    setInterval(() => void this.sync(), 30_000);
    void this.sync();
  }

  private async reload() {
    const all = (await tx<OutItem[]>('readonly', (s) => s.getAll() as IDBRequest<OutItem[]>)) ?? [];
    // keep sent items for 24 h so people can see what went
    const keep = all.filter((i) => i.status !== 'sent' || Date.now() - i.createdAt < 86400_000);
    this.all.set(keep.sort((a, b) => b.createdAt - a.createdAt));
  }

  private async put(i: OutItem) { await tx('readwrite', (s) => s.put(i)); await this.reload(); }

  async add(kind: ItemKind, payload: Record<string, any>, label: string, photo?: Blob | null): Promise<OutItem> {
    const me = this.api.me();
    const item: OutItem = { id: crypto.randomUUID(), kind, payload, photo: photo ?? null, createdAt: Date.now(), status: 'waiting', label,
      tenantId: me?.tenant_id, memberId: me?.id, agentCode: me?.agent_code ?? null };
    await this.put(item);
    void this.sync();
    return item;
  }

  /** Can this item go by SMS, and is it time to offer it? */
  smsOffer(i: OutItem): boolean {
    return ['result', 'incident', 'callback'].includes(i.kind) && i.status !== 'sent' && !i.smsSentAt
      && (!this.online() || Date.now() - i.createdAt > SMS_OFFER_AFTER_MS);
  }

  smsText(i: OutItem): string {
    const code = i.agentCode ?? this.api.me()?.agent_code ?? 'X';
    if (i.kind === 'result') {
      const p = i.payload;
      return encodeResultSms({ puCode: p['pu'], version: p['version'] ?? 1, agentCode: code, registered: p['registered'], accredited: p['accredited'],
        rejected: p['rejected'], totalValid: p['total_valid'], votes: p['votes'] });
    }
    if (i.kind === 'incident') {
      return encodeIncidentSms({ puCode: i.payload['pu'], category: i.payload['category'], severity: i.payload['severity'] as Severity, agentCode: code });
    }
    return encodeCallbackSms({ reason: i.payload['reason'], agentCode: code });
  }

  /** Opens the phone's SMS app with the coded message ready; the agent taps Send. */
  async sendBySms(i: OutItem) {
    const body = encodeURIComponent(this.smsText(i));
    const sep = /iPhone|iPad/.test(navigator.userAgent) ? '&' : '?';
    window.location.href = `sms:${window.RUMFA_CONFIG.smsNumber}${sep}body=${body}`;
    i.smsSentAt = Date.now();
    // Results stay queued so the photo still uploads later (the server merges them);
    // incidents and callbacks without photos are done once the SMS is sent.
    if (i.kind === 'callback' || (i.kind === 'incident' && !i.photo)) i.status = 'sent';
    await this.put(i);
  }

  /** Items the signed-in person still has to send for this organisation. */
  waitingHere() { return this.pending(); }

  async sync() {
    if (this.syncing || !this.api.session() || !this.api.me()) return;
    this.syncing = true;
    try {
      // Only the signed-in person's items for this organisation; other people's wait until they sign in again
      for (const i of this.items().filter((x) => x.status === 'waiting' || x.status === 'sending').reverse()) {
        try {
          i.status = 'sending'; await this.put(i);
          await this.send(i);
          i.status = 'sent'; i.error = undefined; i.photo = null;
          this.online.set(true);
        } catch (e: any) {
          // Business errors (e.g. wrong unit) will not fix themselves; connection and server errors retry
          const retry = !(e instanceof ApiError) || e.network || e.status === 401;
          i.status = retry ? 'waiting' : 'failed';
          i.error = retry ? undefined : e.message;
          if (retry) { if (e instanceof ApiError && e.status === 0) this.online.set(false); await this.put(i); break; }
        }
        await this.put(i);
      }
    } finally { this.syncing = false; }
  }

  private async send(i: OutItem) {
    const p = i.payload;
    const clientId = i.id;
    switch (i.kind) {
      case 'incident': {
        const mediaPaths = i.photo ? [await this.api.upload('incident', i.photo, 'jpg', p['pu'])] : [];
        await this.api.post('/incidents', { pu: p['pu'], category: p['category'], severity: p['severity'] ?? undefined,
          description: p['description'] ?? undefined, mediaPaths, sos: !!p['sos'], clientId });
        return;
      }
      case 'result': {
        const photoPath = i.photo ? await this.api.upload('ec8a', i.photo, 'jpg', p['pu']) : undefined;
        await this.api.post('/results', { pu: p['pu'], registered: p['registered'], accredited: p['accredited'], rejected: p['rejected'],
          totalValid: p['total_valid'], votes: p['votes'], photoPath, clientId });
        return;
      }
      case 'callback':
        await this.api.post('/callbacks', { reason: p['reason'] });
        return;
      case 'checkin':
        await this.api.post('/checkins', { pu: p['pu'], lat: p['lat'], lng: p['lng'], accuracy: p['accuracy'], at: p['at'] ?? new Date(i.createdAt).toISOString(), note: p['note'] ?? undefined, clientId });
        return;
      case 'checklist':
        await this.api.put('/checklist', { pu: p['pu'], item: p['item'], answer: p['answer'], clientId });
        return;
      case 'figures':
        await this.api.post('/unit-figures', { pu: p['pu'], stage: p['stage'], figures: p['figures'], at: p['at'] ?? new Date(i.createdAt).toISOString(), clientId });
        return;
      case 'quick':
        await this.api.post('/quick-tallies', { pu: p['pu'], votes: p['votes'], clientId });
        return;
      case 'message': {
        const mediaPath = i.photo ? await this.api.upload('chat', i.photo, 'jpg') : undefined;
        await this.api.post(`/channels/${p['channel']}/messages`, { kind: p['kind'] ?? undefined, body: p['body'] ?? undefined, mediaPath, clientId });
        return;
      }
    }
  }
}
