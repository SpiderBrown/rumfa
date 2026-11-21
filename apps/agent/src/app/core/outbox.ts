import { Injectable, computed, inject, signal } from '@angular/core';
import { Network } from '@capacitor/network';
import { encodeCallbackSms, encodeIncidentSms, encodeResultSms, type Severity } from '@rumfa/shared';
import { Api, ApiError } from './api';
import { Ui } from './ui';
import { Originals } from './originals';

/**
 * Offline-first queue. Every report is saved on the phone first (IndexedDB),
 * then sent when there is signal. Results, incidents and callback requests can
 * also go by SMS: the app builds the coded message from the saved form, so the
 * agent never types it.
 */
export type ItemKind = 'incident' | 'incident_details' | 'result' | 'callback' | 'checkin' | 'checklist' | 'quick' | 'message' | 'figures';
export interface OutItem {
  id: string;                 // client_id, makes server writes idempotent
  kind: ItemKind;
  payload: Record<string, any>;
  photo?: Blob | null;        // EC8A photo or incident photo
  photos?: Blob[];            // more photos for an incident (the first one is in photo)
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
  private ui = inject(Ui);
  private originals = inject(Originals);
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
    // Full-resolution sheet photos the room asked for: when the app opens, on the push, and every 30 minutes
    void this.originals.sendRequested();
    setInterval(() => void this.originals.sendRequested(), 30 * 60_000);   // a push says when; this is the slow fallback
  }

  private async reload() {
    const all = (await tx<OutItem[]>('readonly', (s) => s.getAll() as IDBRequest<OutItem[]>)) ?? [];
    // keep sent items for 24 h so people can see what went
    const keep = all.filter((i) => i.status !== 'sent' || Date.now() - i.createdAt < 86400_000);
    this.all.set(keep.sort((a, b) => b.createdAt - a.createdAt));
  }

  private async put(i: OutItem) { await tx('readwrite', (s) => s.put(i)); await this.reload(); }

  async add(kind: ItemKind, payload: Record<string, any>, label: string, photo?: Blob | Blob[] | null): Promise<OutItem> {
    const me = this.api.me();
    const list = Array.isArray(photo) ? photo : photo ? [photo] : [];
    const item: OutItem = { id: crypto.randomUUID(), kind, payload, photo: list[0] ?? null, photos: list.slice(1), createdAt: Date.now(), status: 'waiting', label,
      tenantId: me?.tenant_id, memberId: me?.id, agentCode: me?.agent_code ?? null };
    await this.put(item);
    void this.sync();
    return item;
  }

  /** Takes back something not sent yet (e.g. an SOS sent by mistake while there was no signal). False if it already went. */
  async remove(id: string): Promise<boolean> {
    const i = this.all().find((x) => x.id === id);
    if (!i || i.status === 'sent' || i.status === 'sending' || i.smsSentAt) return false;
    await tx('readwrite', (s) => s.delete(id));
    await this.reload();
    return true;
  }

  /** Can this item go by SMS, and is it time to offer it? */
  /** The organisation's SMS number is set (config.js); a placeholder means SMS sending isn't set up */
  readonly smsReady = /^\+?\d{4,15}$/.test(window.RUMFA_CONFIG.smsNumber ?? '') && !/^\+?2340+$/.test(window.RUMFA_CONFIG.smsNumber ?? '');

  smsOffer(i: OutItem): boolean {
    return this.smsReady && ['result', 'incident', 'callback'].includes(i.kind) && i.status !== 'sent' && !i.smsSentAt
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

  /**
   * Opens the phone's SMS app with the coded message ready; the agent taps Send there. The app cannot see whether
   * the SMS was sent (the agent may cancel), so when they come back it asks, and only a "yes" marks it as sent.
   */
  async sendBySms(i: OutItem) {
    const body = encodeURIComponent(this.smsText(i));
    const sep = /iPhone|iPad/.test(navigator.userAgent) ? '&' : '?';
    const back = this.returnedToApp();
    window.location.href = `sms:${window.RUMFA_CONFIG.smsNumber}${sep}body=${body}`;
    await back;
    if (!(await this.ui.confirm('Did the SMS go?', 'Only say yes if you pressed Send in your messages app.', 'Yes, sent', 'Not sent'))) return;
    i.smsSentAt = Date.now();
    // Results stay queued so the photo still uploads later (the server merges them);
    // incidents and callbacks without photos are done once the SMS is sent.
    if (i.kind === 'callback' || (i.kind === 'incident' && !i.photo && !i.photos?.length)) i.status = 'sent';
    await this.put(i);
  }

  /** Resolves when the person comes back from the SMS app (or after a moment, if the app never left the screen). */
  private returnedToApp(): Promise<void> {
    return new Promise((resolve) => {
      let left = false;
      const onVis = () => {
        if (document.hidden) { left = true; return; }
        if (left) { document.removeEventListener('visibilitychange', onVis); setTimeout(resolve, 300); }
      };
      document.addEventListener('visibilitychange', onVis);
      // Some phones open the SMS app in a way that never hides this page; ask after a short pause then
      setTimeout(() => { if (!left) { document.removeEventListener('visibilitychange', onVis); resolve(); } }, 2500);
    });
  }

  /** Sends a refused item again (e.g. after the server's problem was fixed). */
  async retry(i: OutItem) {
    i.status = 'waiting'; i.error = undefined;
    await this.put(i);
    await this.sync();
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
          i.status = 'sent'; i.error = undefined; i.photo = null; i.photos = [];
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
        const mediaPaths: string[] = [];
        for (const b of [i.photo, ...(i.photos ?? [])]) if (b) mediaPaths.push(await this.api.upload('incident', b, 'jpg', p['pu']));
        await this.api.post('/incidents', { pu: p['pu'], category: p['category'], severity: p['severity'] ?? undefined,
          description: p['description'] ?? undefined, mediaPaths, sos: !!p['sos'], clientId });
        return;
      }
      case 'incident_details': {
        // Follows its report (the outbox sends oldest first), found on the server by that report's id
        const mediaPaths: string[] = [];
        for (const b of [i.photo, ...(i.photos ?? [])]) if (b) mediaPaths.push(await this.api.upload('incident', b, 'jpg', p['pu']));
        await this.api.post('/incidents/details', { clientId: p['reportId'], category: p['category'] ?? undefined, note: p['note'] ?? undefined,
          mediaPaths, mistake: p['mistake'] ?? undefined });
        return;
      }
      case 'result': {
        const photoPath = i.photo ? await this.api.upload('ec8a', i.photo, 'jpg', p['pu']) : undefined;
        await this.api.post('/results', { pu: p['pu'], registered: p['registered'], accredited: p['accredited'], rejected: p['rejected'],
          totalValid: p['total_valid'], votes: p['votes'], photoPath, clientId });
        return;
      }
      case 'callback':
        await this.api.post('/callbacks', { reason: p['reason'], note: p['note'] || undefined });
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
