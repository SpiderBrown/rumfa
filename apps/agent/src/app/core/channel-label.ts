/**
 * How a conversation is named on screen. The API sends the parts (place, parents, code, person, problem) and
 * this composes them in the person's language: the name people know first, the code last and small.
 */
export interface ChannelLabel {
  place?: string; parents?: string[]; code?: string | null;
  person?: string; role?: string;
  category?: string; categoryCode?: string; caseStatus?: 'open' | 'closed'; unit?: string | null;
}
export interface Channel {
  id: string; kind: 'ward' | 'lga' | 'state' | 'case' | 'direct'; name: string; area_code: string | null;
  label?: ChannelLabel; last?: { body: string | null; kind: string; sender: string | null; mine: boolean; at: string } | null; unread?: number;
}
type T = (s: string) => string;

const ROLE: Record<string, string> = {
  agent: 'Agent', volunteer: 'Volunteer', coordinator: 'Coordinator', operator: 'Situation room',
  supervisor: 'Situation room supervisor', analyst: 'Situation room', legal: 'Legal desk', security: 'Security desk', admin: 'Administrator',
};

export function channelTitle(c: Channel, t: T): string {
  const l = c.label;
  if (!l) return c.name;
  switch (c.kind) {
    case 'ward': return t('{place} ward team').replace('{place}', l.place ?? '');
    case 'lga': return t('{place} LGA team').replace('{place}', l.place ?? '');
    // The FCT is not a state; "Federal Capital Territory team" reads better than "... State team"
    case 'state': return (/territory/i.test(l.place ?? '') ? t('{place} team') : t('{place} State team')).replace('{place}', l.place ?? '');
    case 'case': return t(l.category ?? 'Problem');
    case 'direct': return l.person ?? c.name;
  }
}

/** Second line: where (parents, unit) or who, with the code last. */
export function channelSubtitle(c: Channel, t: T): string {
  const l = c.label;
  if (!l) return '';
  if (c.kind === 'direct') return t(ROLE[l.role ?? ''] ?? l.role ?? '');
  if (c.kind === 'case') return [l.unit, l.code].filter(Boolean).join(' · ');
  return [...(l.parents ?? []), l.code].filter(Boolean).join(' · ');
}

/** Third line: the last message, like other messaging apps. */
export function channelPreview(c: Channel, t: T): string {
  const m = c.last;
  if (!m) return t('No messages yet');
  const who = m.mine ? t('You') : (m.sender ?? '').split(' ')[0];
  const what = m.kind === 'photo' ? `📷 ${t('Photo')}` : m.kind === 'voice' ? `🎤 ${t('Voice note')}` : m.kind === 'video' ? `🎥 ${t('Video')}` : (m.body ?? '');
  return who && m.kind !== 'system' ? `${who}: ${what}` : what;
}

/** "10:42" today, "Yesterday", or "12 Jan". */
export function channelTime(iso: string | undefined, t: T): string {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (diff === 1) return t('Yesterday');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
