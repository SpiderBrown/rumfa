import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { Api } from '../core/api';
import { Ui } from '../core/ui';

type Step = 'password' | 'invite';

/** Staff sign-in: email + password. Also accepts invite links, and Rumfa Console's one-time "open as admin" links. */
@Component({
  selector: 'app-login',
  imports: [FormsModule, MatCardModule, MatFormFieldModule, MatInputModule, MatButtonModule],
  template: `
  <div class="wrap">
    <mat-card class="card" appearance="outlined">
      <mat-card-header><mat-card-title>{{ api.brand() }} situation room</mat-card-title>
        <mat-card-subtitle>{{ subtitle() }}</mat-card-subtitle></mat-card-header>
      <mat-card-content>
        @switch (step()) {
          @case ('password') {
            <mat-form-field class="full"><mat-label>Email</mat-label>
              <input matInput type="email" autocomplete="username" [(ngModel)]="email" /></mat-form-field>
            <mat-form-field class="full"><mat-label>Password</mat-label>
              <input matInput type="password" autocomplete="current-password" [(ngModel)]="password" (keyup.enter)="login()" /></mat-form-field>
            <button mat-flat-button class="full" [disabled]="busy()" (click)="login()">Sign in</button>
          }
          @case ('invite') {
            <p>Choose a password (at least 8 characters) to finish setting up your account.</p>
            <mat-form-field class="full"><mat-label>New password</mat-label>
              <input matInput type="password" autocomplete="new-password" [(ngModel)]="password" /></mat-form-field>
            <mat-form-field class="full"><mat-label>Repeat password</mat-label>
              <input matInput type="password" autocomplete="new-password" [(ngModel)]="password2" (keyup.enter)="accept()" /></mat-form-field>
            <button mat-flat-button class="full" [disabled]="busy()" (click)="accept()">Save password</button>
          }
        }
      </mat-card-content>
    </mat-card>
  </div>`,
  styles: `.wrap { min-height: 100vh; display: grid; place-items: center; background: var(--mat-sys-surface-container); }
           .card { width: min(420px, 92vw); padding: 8px; } mat-card-content { padding-top: 16px; }
`,
})
export class LoginPage {
  api = inject(Api);
  private ui = inject(Ui);
  private router = inject(Router);
  step = signal<Step>('password');
  busy = signal(false);
  email = '';
  password = '';
  password2 = '';
  private invite = inject(ActivatedRoute).snapshot.queryParamMap.get('invite');

  constructor() {
    if (this.invite) this.step.set('invite');
    // Rumfa Console "Open dashboard as admin": #support=<one-time ticket>
    const ticket = new URLSearchParams(location.hash.slice(1)).get('support');
    if (ticket) {
      history.replaceState(null, '', location.pathname); // the ticket works once; keep it out of the history
      void this.run(async () => { await this.api.supportTicket(ticket); await this.done(); });
    }
  }

  subtitle() {
    return ({ password: 'Sign in with your work email', invite: 'Welcome' } as Record<Step, string>)[this.step()];
  }

  private async run(fn: () => Promise<unknown>) {
    this.busy.set(true);
    try { await fn(); } catch (e) { this.ui.error(e); } finally { this.busy.set(false); }
  }

  login() {
    return this.run(async () => {
      await this.api.login(this.email.trim(), this.password);
      this.password = '';
      await this.done();
    });
  }
  accept() {
    if (this.password.length < 8) { this.ui.error('Use at least 8 characters'); return; }
    if (this.password !== this.password2) { this.ui.error('The two passwords are different'); return; }
    return this.run(async () => {
      const r = await this.api.acceptInvite(this.invite!, this.password);
      this.email = r.email;
      this.password = this.password2 = '';
      this.ui.toast(r.existingAccount ? 'This organisation was added to your account. Sign in with your existing password.' : 'Password saved. Sign in now.');
      await this.router.navigate(['/login'], { queryParams: {} });
      this.step.set('password');
    });
  }
  private async done() { await this.router.navigateByUrl('/'); }
}
