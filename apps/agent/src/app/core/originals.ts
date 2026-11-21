import { Injectable, inject } from '@angular/core';
import { Api } from './api';

/**
 * Full-resolution originals of EC8A sheet photos, kept on this phone (IndexedDB) for 30 days after the light copy
 * was sent. When the situation room asks for one (push, or seen when the app opens or syncs), it's uploaded.
 */
const DB = 'rumfa-originals';
const STORE = 'photos';
const KEEP_MS = 30 * 86400_000;
interface Original { clientId: string; pu: string; blob: Blob; createdAt: number; sentAt?: number }

function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'clientId' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((res, rej) => { const q = fn(d.transaction(STORE, mode).objectStore(STORE)); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}

@Injectable({ providedIn: 'root' })
export class Originals {
  private api = inject(Api);
  private busy = false;

  async keep(clientId: string, pu: string, blob: Blob) {
    await run('readwrite', (s) => s.put({ clientId, pu, blob, createdAt: Date.now() } satisfies Original));
    void this.prune();
  }

  /** Uploads any originals the room asked for. Safe to call often. */
  async sendRequested(): Promise<number> {
    if (this.busy || !this.api.me() || !['agent', 'coordinator'].includes(this.api.me()!.role)) return 0;
    this.busy = true;
    let sent = 0;
    try {
      const asked = await this.api.get<{ id: string; client_id: string; pu_code: string }[]>('/results/full-photo-requests').catch(() => []);
      for (const r of asked) {
        const o = await run<Original | undefined>('readonly', (s) => s.get(r.client_id) as IDBRequest<Original | undefined>).catch(() => undefined);
        if (!o) continue;
        const path = await this.api.upload('ec8a', o.blob, 'jpg', r.pu_code);
        await this.api.post(`/results/${r.id}/full-photo`, { path });
        await run('readwrite', (s) => s.put({ ...o, sentAt: Date.now() }));
        sent++;
      }
    } catch { /* tried again on the next sync */ }
    this.busy = false;
    return sent;
  }

  private async prune() {
    const all = await run<Original[]>('readonly', (s) => s.getAll() as IDBRequest<Original[]>).catch(() => [] as Original[]);
    for (const o of all) if (Date.now() - o.createdAt > KEEP_MS) await run('readwrite', (s) => s.delete(o.clientId)).catch(() => undefined);
  }
}
