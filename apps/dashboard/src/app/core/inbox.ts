import { Injectable, computed, inject, signal } from '@angular/core';
import { Api } from './api';

export interface ChannelLabel {
  place?: string; parents?: string[]; code?: string | null; person?: string; role?: string;
  category?: string; categoryCode?: string; caseStatus?: 'open' | 'closed'; unit?: string | null;
}
export interface Conversation {
  id: string; kind: 'direct' | 'case' | 'ward' | 'lga' | 'state'; case_id: string | null; area_code: string | null;
  member_a: string | null; member_b: string | null; last_at: string | null; created_at: string;
  label: ChannelLabel; last: { body: string | null; kind: string; sender: string | null; mine: boolean; at: string } | null; unread: number;
}

/** Someone in the field who asked to be called ("Ask my coordinator to call me") */
export interface CallRequest {
  id: string; requester_id: string; reason: string; status: string; channel: 'app' | 'sms'; attempts: number; escalation_level: number;
  due_at: string; created_at: string; case_id: string | null; voice_note_path: string | null; assigned_to: string | null;
  requester: { full_name: string; phone: string; area_code: string };
}
/** One call, for the call log */
export interface CallLog {
  id: string; caller_id: string | null; callee_id: string | null; route: string; status: string; duration_s: number | null; reason: string | null;
  case_id: string | null; callback_id: string | null; started_at: string; contact_id: string | null;
  caller_name: string | null; callee_name: string | null; caller_role: string | null; callee_role: string | null; contact_agency: string | null; contact_title: string | null;
}
export const OPEN_REQUEST = ['waiting', 'calling', 'no_answer', 'escalated'];
export const REQUEST_REASON: Record<string, string> = { form: 'Question about a form', unit: 'Problem at my polling unit', app: 'App or phone problem', other: 'Something else' };

/**
 * Messages and calls for Room staff, kept fresh: conversations (direct, area teams, cases), people waiting for a
 * call, and the call log. The menu shows unread messages plus people waiting.
 */
@Injectable({ providedIn: 'root' })
export class Inbox {
  private api = inject(Api);
  readonly list = signal<Conversation[]>([]);
  readonly loaded = signal(false);
  /** Direct and area chats only: case chats are already counted on the cases themselves */
  readonly unread = computed(() => this.list().filter((c) => c.kind !== 'case').reduce((n, c) => n + c.unread, 0));
  readonly requests = signal<CallRequest[]>([]);
  readonly callLog = signal<CallLog[]>([]);
  /** For the menu badge: unread direct and team messages, plus people waiting for a call */
  readonly attention = computed(() => this.unread() + this.requests().length);
  private started = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  start() {
    if (this.started) return;
    this.started = true;
    void this.load();
    this.api.onChange(() => this.soon(), ['messages', 'channels', 'callback_requests', 'calls']);
    setInterval(() => void this.load(), 120_000);
  }
  soon() { this.timer ??= setTimeout(() => { this.timer = null; void this.load(); }, 800); }
  async load() {
    // Each part on its own, so one failing doesn't blank the others
    await Promise.all([
      this.api.get<Conversation[]>('/channels').then((l) => this.list.set(l), () => undefined),
      this.api.get<CallRequest[]>('/callbacks', { status: OPEN_REQUEST.join(',') }).then((r) => this.requests.set(r), () => undefined),
      this.api.get<CallLog[]>('/calls/log').then((r) => this.callLog.set(r), () => undefined),
    ]);
    this.loaded.set(true);
  }
  /** Mark one as read here as soon as it's opened (the server marks it when the messages are fetched) */
  read(id: string) { this.list.update((l) => l.map((c) => (c.id === id ? { ...c, unread: 0 } : c))); }
}

const LEVEL: Record<string, string> = { ward: 'ward team', lga: 'LGA team', state: 'state team' };
const ROLE: Record<string, string> = { agent: 'Agent', volunteer: 'Volunteer', coordinator: 'Coordinator', operator: 'Operator', supervisor: 'Supervisor',
  analyst: 'Analyst', legal: 'Legal', security: 'Security', voice_ops: 'Voice outreach', admin: 'Admin' };

export function convTitle(c: Conversation): string {
  if (c.kind === 'direct') return c.label.person ?? 'Someone';
  if (c.kind === 'case') return c.label.category ?? 'Case';
  return `${c.label.place ?? c.area_code} ${LEVEL[c.kind] ?? ''}`.trim();
}
export function convSub(c: Conversation): string {
  if (c.kind === 'direct') return ROLE[c.label.role ?? ''] ?? 'Direct message';
  if (c.kind === 'case') return [c.label.caseStatus === 'closed' ? 'Closed case' : 'Open case', c.label.unit].filter(Boolean).join(' · ');
  return (c.label.parents ?? []).join(' · ') || 'Everyone in the area';
}
export function convIcon(c: Conversation): string {
  return c.kind === 'direct' ? 'person' : c.kind === 'case' ? 'report' : 'groups';
}
