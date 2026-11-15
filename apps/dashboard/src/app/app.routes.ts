import { inject } from '@angular/core';
import { Router, type CanActivateFn, type Routes } from '@angular/router';
import { Api } from './core/api';

const signedIn: CanActivateFn = () => {
  const s = inject(Api);
  return s.me() ? true : inject(Router).parseUrl('/login');
};
const roles = (...r: string[]): CanActivateFn => () => r.includes(inject(Api).me()?.role ?? '') || inject(Router).parseUrl('/');

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./pages/login').then((m) => m.LoginPage) },
  {
    path: '', canActivate: [signedIn], loadComponent: () => import('./shell').then((m) => m.Shell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'room' },
      { path: 'room', loadComponent: () => import('./pages/room/queue').then((m) => m.QueuePage) },
      { path: 'room/case/:id', loadComponent: () => import('./pages/room/case-detail').then((m) => m.CaseDetailPage) },
      { path: 'callbacks', loadComponent: () => import('./pages/callbacks').then((m) => m.CallbacksPage) },
      { path: 'results', canActivate: [roles('analyst', 'supervisor', 'admin', 'legal', 'operator')], loadComponent: () => import('./pages/results').then((m) => m.ResultsPage) },
      { path: 'irev', canActivate: [roles('analyst', 'supervisor', 'admin')], loadComponent: () => import('./pages/irev').then((m) => m.IrevPage) },
      { path: 'irev/review', canActivate: [roles('analyst', 'supervisor', 'admin', 'legal')], loadComponent: () => import('./pages/irev-review').then((m) => m.IrevReviewPage) },
      { path: 'contacts', loadComponent: () => import('./pages/contacts').then((m) => m.ContactsPage) },
      { path: 'people', loadComponent: () => import('./pages/people').then((m) => m.PeoplePage) },
      { path: 'shifts', canActivate: [roles('supervisor', 'admin')], loadComponent: () => import('./pages/shifts').then((m) => m.ShiftsPage) },
      { path: 'topups', canActivate: [roles('admin')], loadComponent: () => import('./pages/topups').then((m) => m.TopupsPage) },
      { path: 'settings', canActivate: [roles('admin')], loadComponent: () => import('./pages/settings').then((m) => m.SettingsPage) },
      { path: 'voice', canActivate: [roles('voice_ops', 'admin')], loadComponent: () => import('./pages/voice').then((m) => m.VoicePage) },
    ],
  },
  { path: '**', redirectTo: '' },
];
