import { EventEmitter } from 'node:events';

/**
 * Changes the API makes itself and wants on people's screens at once (app calls ringing, answered, ended), without
 * waiting for the database's change feed. The gateway sends them to the right sockets; the same change arriving
 * again from the feed is harmless (the apps ignore what they already know).
 */
export const liveBus = new EventEmitter();
export const publishChange = (e: Record<string, unknown>) => liveBus.emit('change', e);
