/** A picture for each kind of problem, so people find theirs without reading the whole list */
export const CATEGORY_ICONS: Record<string, string> = {
  violence: 'flame', ballot_snatching: 'file-tray-full', thugs: 'skull', agent_denied: 'hand-left', vote_buying: 'cash',
  materials_late: 'hourglass', bvas_failure: 'finger-print', voters_turned_away: 'person-remove', result_not_posted: 'newspaper',
  result_dispute: 'document-text', upload_failed: 'cloud-offline', app_problem: 'phone-portrait', other: 'ellipsis-horizontal-circle',
};

export const categoryIcon = (code: string | null | undefined) => CATEGORY_ICONS[code ?? ''] ?? 'alert-circle';

/** A colour for each kind of problem (tile background and icon), so the screen reads at a glance */
export const CATEGORY_COLOURS: Record<string, string> = {
  violence: '#dc2626', ballot_snatching: '#b91c1c', thugs: '#7f1d1d', agent_denied: '#ea580c', vote_buying: '#16a34a',
  materials_late: '#d97706', bvas_failure: '#7c3aed', voters_turned_away: '#db2777', result_not_posted: '#2563eb',
  result_dispute: '#0891b2', upload_failed: '#0284c7', app_problem: '#475569', other: '#64748b',
};
export const categoryColour = (code: string | null | undefined) => CATEGORY_COLOURS[code ?? ''] ?? '#0f766e';
