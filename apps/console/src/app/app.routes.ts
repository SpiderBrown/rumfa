import { inject } from '@angular/core';
import { CanActivateFn, Router, Routes } from '@angular/router';
import { Api } from './core/api';

const signedIn: CanActivateFn = () => (inject(Api).me() ? true : inject(Router).parseUrl('/login'));

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./pages/login').then((m) => m.LoginPage) },
  { path: 'invite', loadComponent: () => import('./pages/login').then((m) => m.LoginPage) },
  {
    path: '', canActivate: [signedIn], loadComponent: () => import('./shell').then((m) => m.Shell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'clients' },
      { path: 'clients', loadComponent: () => import('./pages/clients').then((m) => m.ClientsPage) },
      { path: 'clients/new', loadComponent: () => import('./pages/onboard').then((m) => m.OnboardPage) },
      { path: 'clients/:id', loadComponent: () => import('./pages/client').then((m) => m.ClientPage) },
      { path: 'parties', loadComponent: () => import('./pages/parties').then((m) => m.PartiesPage) },
      { path: 'contacts', loadComponent: () => import('./pages/contacts').then((m) => m.ContactsPage) },
      { path: 'places', loadComponent: () => import('./pages/places').then((m) => m.PlacesPage) },
      { path: 'elections', loadComponent: () => import('./pages/elections').then((m) => m.ElectionsPage) },
      { path: 'jobs', loadComponent: () => import('./pages/jobs').then((m) => m.JobsPage) },
      { path: 'irev', loadComponent: () => import('./pages/irev').then((m) => m.IrevPage) },
      { path: 'staff', loadComponent: () => import('./pages/staff').then((m) => m.StaffPage) },
      { path: 'activity', loadComponent: () => import('./pages/activity').then((m) => m.ActivityPage) },
    ],
  },
  { path: '**', redirectTo: '' },
];
