/** Each kind of queue has its colour, used on its card, its group, its cases and its shifts */
export const QUEUE_KIND: Record<string, { colour: string; soft: string; hint: string; order: number }> = {
  security: { colour: '#a1251b', soft: '#f6e3e1', hint: 'Violence, thugs, snatching', order: 0 },
  legal: { colour: '#5b3fa8', soft: '#ebe6f6', hint: 'Results, agent denied, vote buying', order: 1 },
  state: { colour: '#1f4e8c', soft: '#e1e9f4', hint: 'Materials, BVAS, voters turned away', order: 2 },
  helpdesk: { colour: '#0f766e', soft: '#dff0ee', hint: 'App, phone, forms', order: 3 },
  national: { colour: '#3d4652', soft: '#e6e8eb', hint: 'Escalated from the states', order: 4 },
};
export const OTHER_QUEUE = { colour: '#5b6675', soft: '#eceef1', hint: '', order: 9 };
export const kindOf = (k: string) => QUEUE_KIND[k] ?? OTHER_QUEUE;
