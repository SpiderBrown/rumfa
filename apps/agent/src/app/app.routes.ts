import { inject } from '@angular/core';
import { Router, type CanActivateFn, type Routes } from '@angular/router';
import { Api } from './core/api';
import { Pin } from './core/pin';
import { Checkin } from './core/checkin';

/** Phone activated, PIN entered, and onboarded. */
const ready: CanActivateFn = () => {
  const s = inject(Api), pin = inject(Pin), r = inject(Router);
  if (!s.hasDevice() || !pin.hasPin() || !s.me()) return r.parseUrl('/login');
  if (!pin.unlocked()) return r.parseUrl('/lock');   // also renews an expired session with the PIN
  if (!s.me()!.onboarded_at) return r.parseUrl('/onboarding');
  return true;
};

/** Field pages (checklist, report, live count, result) wait for check-in at the unit. SOS never waits. */
const checkedIn: CanActivateFn = (route) => {
  const s = inject(Api), r = inject(Router);
  if (route.queryParamMap.get('sos') === '1' || !s.atUnit() || !inject(Checkin).required()) return true;
  return r.parseUrl('/');
};

/** Where "/" lands: coordinators on their area, everyone else on Today. */
const landing: CanActivateFn = () => inject(Router).parseUrl(inject(Api).isCoordinator() ? '/tabs/area' : '/tabs/today');

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./pages/login').then((m) => m.default) },
  { path: 'lock', loadComponent: () => import('./pages/lock').then((m) => m.default) },
  { path: 'onboarding', loadComponent: () => import('./pages/onboarding').then((m) => m.default) },
  // Main sections as bottom tabs (by role); everything below opens on top of them
  {
    path: 'tabs', canActivate: [ready], loadComponent: () => import('./pages/tabs').then((m) => m.default),
    children: [
      { path: 'today', loadComponent: () => import('./pages/unit').then((m) => m.default) },
      { path: 'chats', loadComponent: () => import('./pages/messages').then((m) => m.default) },
      { path: 'me', loadComponent: () => import('./pages/me').then((m) => m.default) },
      { path: 'area', loadComponent: () => import('./pages/coord-map').then((m) => m.default) },
      { path: 'requests', loadComponent: () => import('./pages/coord-callbacks').then((m) => m.default) },
      { path: '', pathMatch: 'full', redirectTo: 'today' },
    ],
  },
  { path: '', pathMatch: 'full', canActivate: [ready, landing], children: [] },
  // After holding SOS (already sent): never waits for check-in
  { path: 'sos/:id', canActivate: [ready], loadComponent: () => import('./pages/sos').then((m) => m.default) },
  { path: 'report', canActivate: [ready, checkedIn], loadComponent: () => import('./pages/report').then((m) => m.default) },
  { path: 'result', canActivate: [ready, checkedIn], loadComponent: () => import('./pages/result').then((m) => m.default) },
  { path: 'count', canActivate: [ready, checkedIn], loadComponent: () => import('./pages/count').then((m) => m.default) },
  { path: 'callback', canActivate: [ready], loadComponent: () => import('./pages/callback').then((m) => m.default) },
  { path: 'chat/:id', canActivate: [ready], loadComponent: () => import('./pages/chat').then((m) => m.default) },
  { path: 'coord/team', canActivate: [ready], loadComponent: () => import('./pages/coord-team').then((m) => m.default) },
  { path: 'coord/contact', canActivate: [ready], loadComponent: () => import('./pages/coord-contact').then((m) => m.default) },
  { path: 'live/:id', canActivate: [ready], loadComponent: () => import('./pages/live').then((m) => m.default) },
  // Older addresses (links, notifications) lead to the tabs
  { path: 'unit', redirectTo: 'tabs/today' },
  { path: 'checklist', redirectTo: 'tabs/today' },
  { path: 'quick', redirectTo: 'count' },
  { path: 'messages', redirectTo: 'tabs/chats' },
  { path: 'help', redirectTo: 'tabs/me' },
  { path: 'coord/map', redirectTo: 'tabs/area' },
  { path: 'coord/callbacks', redirectTo: 'tabs/requests' },
  { path: '**', redirectTo: '' },
];
