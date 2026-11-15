import { inject } from '@angular/core';
import { Router, type CanActivateFn, type Routes } from '@angular/router';
import { Api } from './core/api';
import { Pin } from './core/pin';

/** Phone activated, PIN entered, and onboarded. */
const ready: CanActivateFn = () => {
  const s = inject(Api), pin = inject(Pin), r = inject(Router);
  if (!s.hasDevice() || !pin.hasPin() || !s.me()) return r.parseUrl('/login');
  if (!pin.unlocked()) return r.parseUrl('/lock');   // also renews an expired session with the PIN
  if (!s.me()!.onboarded_at) return r.parseUrl('/onboarding');
  return true;
};

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./pages/login').then((m) => m.default) },
  { path: 'lock', loadComponent: () => import('./pages/lock').then((m) => m.default) },
  { path: 'onboarding', loadComponent: () => import('./pages/onboarding').then((m) => m.default) },
  { path: '', canActivate: [ready], loadComponent: () => import('./pages/home').then((m) => m.default) },
  { path: 'report', canActivate: [ready], loadComponent: () => import('./pages/report').then((m) => m.default) },
  { path: 'result', canActivate: [ready], loadComponent: () => import('./pages/result').then((m) => m.default) },
  { path: 'count', canActivate: [ready], loadComponent: () => import('./pages/count').then((m) => m.default) },
  { path: 'quick', redirectTo: 'count' },
  { path: 'checklist', canActivate: [ready], loadComponent: () => import('./pages/checklist').then((m) => m.default) },
  { path: 'callback', canActivate: [ready], loadComponent: () => import('./pages/callback').then((m) => m.default) },
  { path: 'messages', canActivate: [ready], loadComponent: () => import('./pages/messages').then((m) => m.default) },
  { path: 'chat/:id', canActivate: [ready], loadComponent: () => import('./pages/chat').then((m) => m.default) },
  { path: 'coord/callbacks', canActivate: [ready], loadComponent: () => import('./pages/coord-callbacks').then((m) => m.default) },
  { path: 'coord/map', canActivate: [ready], loadComponent: () => import('./pages/coord-map').then((m) => m.default) },
  { path: 'coord/team', canActivate: [ready], loadComponent: () => import('./pages/coord-team').then((m) => m.default) },
  { path: 'coord/contact', canActivate: [ready], loadComponent: () => import('./pages/coord-contact').then((m) => m.default) },
  { path: 'live/:id', canActivate: [ready], loadComponent: () => import('./pages/live').then((m) => m.default) },
  { path: 'help', canActivate: [ready], loadComponent: () => import('./pages/help').then((m) => m.default) },
  { path: '**', redirectTo: '' },
];
