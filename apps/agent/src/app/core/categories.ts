/** A picture for each kind of problem, so people find theirs without reading the whole list */
export const CATEGORY_ICONS: Record<string, string> = {
  violence: 'flame', ballot_snatching: 'file-tray-full', thugs: 'skull', agent_denied: 'hand-left', vote_buying: 'cash',
  materials_late: 'hourglass', bvas_failure: 'finger-print', voters_turned_away: 'person-remove', result_not_posted: 'newspaper',
  result_dispute: 'document-text', upload_failed: 'cloud-offline', app_problem: 'phone-portrait', other: 'ellipsis-horizontal-circle',
};

export const categoryIcon = (code: string | null | undefined) => CATEGORY_ICONS[code ?? ''] ?? 'alert-circle';
