import { Injectable, computed, inject, signal } from '@angular/core';
import { Network } from '@capacitor/network';
import { encodeCallbackSms, encodeIncidentSms, encodeResultSms, type Severity } from '@rumfa/shared';
import { Supa } from './supa';

/**
 * Offline-first queue. Every report is saved on the phone first (IndexedDB),
 * then sent when there is signal. Results, incidents and callback requests can
 * also go by SMS: the app builds the coded message from the saved form, so the
 * agent never types it.
 */
export type ItemKind = 'incident' | 'result' | 'callback' | 'checkin' | 'checklist' | 'quick' | 'message';
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
  private supa = inject(Supa);
  readonly items = signal<OutItem[]>([]);
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
    this.items.set(keep.sort((a, b) => b.createdAt - a.createdAt));
  }

  private async put(i: OutItem) { await tx('readwrite', (s) => s.put(i)); await this.reload(); }

  async add(kind: ItemKind, payload: Record<string, any>, label: string, photo?: Blob | null): Promise<OutItem> {
    const item: OutItem = { id: crypto.randomUUID(), kind, payload, photo: photo ?? null, createdAt: Date.now(), status: 'waiting', label };
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
    const me = this.supa.me()!;
    const code = me.agent_code ?? 'X';
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

  async sync() {
    if (this.syncing || !this.supa.session()) return;
    this.syncing = true;
    try {
      for (const i of this.items().filter((x) => x.status === 'waiting' || x.status === 'sending').reverse()) {
        try {
          i.status = 'sending'; await this.put(i);
          await this.send(i);
          i.status = 'sent'; i.error = undefined; i.photo = null;
        } catch (e: any) {
          // business errors (e.g. wrong unit) won't fix themselves; network errors retry
          const msg = e?.message ?? String(e);
          const network = /fetch|network|Failed to|timeout/i.test(msg);
          i.status = network ? 'waiting' : 'failed';
          i.error = network ? undefined : msg;
          if (network) { this.online.set(false); await this.put(i); break; }
        }
        await this.put(i);
      }
    } finally { this.syncing = false; }
  }

  private async upload(bucket: string, folder: string, blob: Blob): Promise<string> {
    const me = this.supa.me()!;
    const path = `${me.tenant_id}/${folder}/${crypto.randomUUID()}.jpg`;
    const { error } = await this.supa.client.storage.from(bucket).upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: false });
    if (error) throw new Error(error.message);
    return path;
  }

  private async send(i: OutItem) {
    const p = i.payload;
    const me = this.supa.me()!;
    switch (i.kind) {
      case 'incident': {
        const media = i.photo ? [await this.upload('incident-media', p['pu'], i.photo)] : [];
        await this.supa.rpc('report_incident', { p_pu: p['pu'], p_category: p['category'], p_severity: p['severity'] ?? null,
          p_description: p['description'] ?? null, p_media: media, p_client_id: i.id, p_is_sos: !!p['sos'] });
        return;
      }
      case 'result': {
        const photo = i.photo ? await this.upload('ec8a', p['pu'], i.photo) : null;
        await this.supa.rpc('submit_result', { p_pu: p['pu'], p_registered: p['registered'], p_accredited: p['accredited'], p_rejected: p['rejected'],
          p_total_valid: p['total_valid'], p_votes: p['votes'], p_photo: photo, p_client_id: i.id });
        return;
      }
      case 'callback':
        await this.supa.rpc('request_callback', { p_reason: p['reason'], p_voice_note: null });
        return;
      case 'checkin': {
        const { data: te } = await this.supa.client.from('tenant_elections').select('election_id').eq('purpose', 'live').single();
        const { error } = await this.supa.client.from('checkins').insert({ tenant_id: me.tenant_id, election_id: te!.election_id, volunteer_id: me.id,
          pu_code: p['pu'], lat: p['lat'], lng: p['lng'], accuracy_m: p['accuracy'], client_id: i.id, at: new Date(i.createdAt).toISOString() });
        if (error && error.code !== '23505') throw new Error(error.message);
        return;
      }
      case 'checklist': {
        const { data: te } = await this.supa.client.from('tenant_elections').select('election_id').eq('purpose', 'live').single();
        const { error } = await this.supa.client.from('checklist_responses').upsert({ tenant_id: me.tenant_id, election_id: te!.election_id,
          volunteer_id: me.id, pu_code: p['pu'], item_code: p['item'], answer: p['answer'], client_id: i.id }, { onConflict: 'election_id,volunteer_id,item_code' });
        if (error) throw new Error(error.message);
        return;
      }
      case 'quick': {
        const { data: te } = await this.supa.client.from('tenant_elections').select('election_id').eq('purpose', 'live').single();
        const { error } = await this.supa.client.from('quick_tallies').insert({ tenant_id: me.tenant_id, election_id: te!.election_id,
          volunteer_id: me.id, pu_code: p['pu'], votes: p['votes'], client_id: i.id });
        if (error && error.code !== '23505') throw new Error(error.message);
        return;
      }
      case 'message': {
        const media = i.photo ? await this.upload('chat-media', 'chat', i.photo) : null;
        const { error } = await this.supa.client.from('messages').insert({ tenant_id: me.tenant_id, channel_id: p['channel'], sender_id: me.id,
          kind: p['kind'] ?? 'text', body: p['body'] ?? null, media_path: media, client_id: i.id, sent_at: new Date(i.createdAt).toISOString() });
        if (error && error.code !== '23505') throw new Error(error.message);
        return;
      }
    }
  }
}
