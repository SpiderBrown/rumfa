/**
 * What a seat means for a client: the area it covers, the level its people work at, and which levels its first
 * coordinators may be at. A seat's area is a code: NG, a state (19), a senatorial district (19-SD1), an LGA (19-28)
 * or a ward (19-28-02).
 */
export type Seat = 'presidential' | 'governorship' | 'senate' | 'reps' | 'state_assembly' | 'chairman' | 'councillor' | 'fct_area_council';

export const SEATS: { seat: Seat; label: string; area: 'national' | 'state' | 'senatorial' | 'constituency' | 'lga' | 'ward'; ready: boolean }[] = [
  { seat: 'presidential', label: 'President', area: 'national', ready: true },
  { seat: 'governorship', label: 'Governor', area: 'state', ready: true },
  { seat: 'senate', label: 'Senate', area: 'senatorial', ready: true },
  { seat: 'reps', label: 'House of Representatives', area: 'constituency', ready: true },
  { seat: 'state_assembly', label: 'State House of Assembly', area: 'constituency', ready: true },
  { seat: 'chairman', label: 'LGA Chairman', area: 'lga', ready: true },
  { seat: 'fct_area_council', label: 'FCT Area Council Chairman', area: 'lga', ready: true },
  { seat: 'councillor', label: 'Councillor', area: 'ward', ready: true },
];

const AREA_RE: Record<string, RegExp> = {
  national: /^NG$/, state: /^\d{2}$/, senatorial: /^\d{2}-SD\d$/, lga: /^\d{2}-\d{2}$/, ward: /^\d{2}-\d{2}-\d{2}$/,
};

export function seatInfo(seat: string) {
  return SEATS.find((s) => s.seat === seat);
}

export function seatAreaValid(seat: string, area: string): boolean {
  const s = seatInfo(seat);
  if (seat === 'reps') return /^\d{2}-FC\d+$/.test(area);
  if (seat === 'state_assembly') return /^\d{2}-SC\d+$/.test(area);
  return !!s && !!AREA_RE[s.area]?.test(area) && (seat !== 'fct_area_council' || area.startsWith('37-'));
}

/**
 * Where the client's room staff (admins) work: the whole seat area, or for a district the state it is in (people
 * have no district level yet).
 */
export function staffArea(seat: string, area: string): { level: string; area: string } {
  const s = seatInfo(seat)!;
  if (s.area === 'national') return { level: 'national', area: 'NG' };
  if (s.area === 'state' || s.area === 'senatorial' || s.area === 'constituency') return { level: 'state', area: area.slice(0, 2) };
  if (s.area === 'lga') return { level: 'lga', area };
  return { level: 'ward', area };
}

/** Levels the first coordinators may be at, top first. */
export function coordinatorLevels(seat: string): string[] {
  const s = seatInfo(seat)!;
  return ({ national: ['national', 'state'], state: ['state', 'lga'], senatorial: ['lga'], constituency: ['lga'], lga: ['lga', 'ward'], ward: ['ward'] } as Record<string, string[]>)[s.area] ?? [];
}

/** Is a coordinator's area inside the seat? `lgasOfDistrict` lists a senatorial district's or constituency's LGAs. */
export function insideSeat(seat: string, seatArea: string, code: string, lgasOfDistrict: string[] = []): boolean {
  const s = seatInfo(seat)!;
  if (s.area === 'national') return true;
  if (s.area === 'senatorial' || s.area === 'constituency') return lgasOfDistrict.some((l) => code === l || code.startsWith(l + '-'));
  return code === seatArea || code.startsWith(seatArea + '-');
}
