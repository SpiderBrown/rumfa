import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { Api } from '../core/api';
import { Ui } from '../core/ui';

type Step = 'password' | 'mfa' | 'setup' | 'invite';

/** Staff sign-in: email + password, then an authenticator code for roles that need one. Also accepts invite links. */
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
          @case ('mfa') {
            <p>Enter the 6-digit code from your authenticator app.</p>
            <mat-form-field class="full"><mat-label>Code</mat-label>
              <input matInput inputmode="numeric" maxlength="6" autocomplete="one-time-code" [(ngModel)]="code" (keyup.enter)="mfa()" /></mat-form-field>
            <button mat-flat-button class="full" [disabled]="busy()" (click)="mfa()">Continue</button>
          }
          @case ('setup') {
            <p>Your role needs an authenticator app (Google Authenticator, Microsoft Authenticator or Authy).
               Add an account with this key, then enter the code it shows.</p>
            @if (secret()) { <p class="key">{{ secret() }}</p> <p class="hint"><a [href]="otpauth()">Open in authenticator app</a></p> }
            <mat-form-field class="full"><mat-label>Code</mat-label>
              <input matInput inputmode="numeric" maxlength="6" [(ngModel)]="code" (keyup.enter)="enable()" /></mat-form-field>
            <button mat-flat-button class="full" [disabled]="busy()" (click)="enable()">Turn on and sign in</button>
          }
          @case ('invite') {
            <p>Choose a password (at least 10 characters) to finish setting up your account.</p>
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
           .key { font-family: monospace; font-size: 15px; letter-spacing: 1px; word-break: break-all; background: var(--mat-sys-surface-container-high); padding: 8px; border-radius: 6px; }`,
})
export class LoginPage {
  api = inject(Api);
  private ui = inject(Ui);
  private router = inject(Router);
  step = signal<Step>('password');
  busy = signal(false);
  secret = signal('');
  otpauth = signal('');
  email = '';
  password = '';
  password2 = '';
  code = '';
  private token = '';
  private invite = inject(ActivatedRoute).snapshot.queryParamMap.get('invite');

  constructor() { if (this.invite) this.step.set('invite'); }

  subtitle() {
    return ({ password: 'Sign in with your work email', mfa: 'Second step', setup: 'Set up your authenticator', invite: 'Welcome' } as Record<Step, string>)[this.step()];
  }

  private async run(fn: () => Promise<unknown>) {
    this.busy.set(true);
    try { await fn(); } catch (e) { this.ui.error(e); } finally { this.busy.set(false); }
  }

  login() {
    return this.run(async () => {
      const r = await this.api.login(this.email.trim(), this.password);
      this.password = '';
      if (r.step === 'done') return this.done();
      this.token = r.token;
      this.code = '';
      if (r.step === 'setup') {
        const s = await this.api.totpSetup(this.token);
        this.secret.set(s.secret.replace(/(.{4})/g, '$1 ').trim());
        this.otpauth.set(s.otpauthUrl);
      }
      this.step.set(r.step);
    });
  }
  mfa() { return this.run(async () => { await this.api.mfa(this.token, this.code.trim()); await this.done(); }); }
  enable() { return this.run(async () => { await this.api.totpEnable(this.token, this.code.trim()); await this.done(); }); }
  accept() {
    if (this.password.length < 10) { this.ui.error('Use at least 10 characters'); return; }
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
