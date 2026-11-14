import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { normaliseNgPhone } from '@alawa/shared';
import { Supa } from '../core/supabase';
import { Ui } from '../core/ui';

@Component({
  selector: 'app-login',
  imports: [FormsModule, MatCardModule, MatFormFieldModule, MatInputModule, MatButtonModule],
  template: `
  <div class="wrap">
    <mat-card class="card" appearance="outlined">
      <mat-card-header><mat-card-title>ALAWA situation room</mat-card-title>
        <mat-card-subtitle>Sign in with your registered phone number</mat-card-subtitle></mat-card-header>
      <mat-card-content>
        @if (step() === 'phone') {
          <mat-form-field class="full"><mat-label>Phone number</mat-label>
            <input matInput [(ngModel)]="phone" placeholder="0803 123 4567" inputmode="tel" (keyup.enter)="send()" /></mat-form-field>
          <button mat-flat-button class="full" [disabled]="busy()" (click)="send()">Send code</button>
        } @else {
          <p>Enter the 6-digit code sent to {{ e164 }}.</p>
          <mat-form-field class="full"><mat-label>Code</mat-label>
            <input matInput [(ngModel)]="code" inputmode="numeric" maxlength="6" (keyup.enter)="verify()" /></mat-form-field>
          <button mat-flat-button class="full" [disabled]="busy()" (click)="verify()">Sign in</button>
          <button mat-button class="full" (click)="step.set('phone')">Use another number</button>
        }
      </mat-card-content>
    </mat-card>
  </div>`,
  styles: `.wrap { min-height: 100vh; display: grid; place-items: center; background: var(--mat-sys-surface-container); }
           .card { width: min(420px, 92vw); padding: 8px; } mat-card-content { padding-top: 16px; }`,
})
export class LoginPage {
  private supa = inject(Supa);
  private ui = inject(Ui);
  private router = inject(Router);
  step = signal<'phone' | 'code'>('phone');
  busy = signal(false);
  phone = '';
  code = '';
  e164 = '';

  async send() {
    const p = normaliseNgPhone(this.phone);
    if (!p) { this.ui.error('Enter a valid Nigerian mobile number'); return; }
    this.busy.set(true);
    const { error } = await this.supa.client.auth.signInWithOtp({ phone: p });
    this.busy.set(false);
    if (error) { this.ui.error(error.message); return; }
    this.e164 = p;
    this.step.set('code');
  }

  async verify() {
    this.busy.set(true);
    const { error } = await this.supa.client.auth.verifyOtp({ phone: this.e164, token: this.code.trim(), type: 'sms' });
    this.busy.set(false);
    if (error) { this.ui.error(error.message); return; }
    await this.supa.init();
    if (!this.supa.me()) { this.ui.error('This number is not registered on the platform.'); await this.supa.client.auth.signOut(); return; }
    await this.router.navigateByUrl('/');
  }
}
