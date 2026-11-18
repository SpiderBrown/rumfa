import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { Api } from '../core/api';

type Step = 'password' | 'invite';

/** Rumfa Console sign-in: email and password. Also sets a password from an invite link. */
@Component({
  selector: 'page-login',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule],
  template: `
  <div class="wrap">
    <form class="box" (ngSubmit)="submit()">
      <h1>Rumfa Console</h1>
      <p class="sub">{{ title() }}</p>
      @switch (step()) {
        @case ('password') {
          <mat-form-field class="full"><mat-label>Email</mat-label><input matInput type="email" name="email" [(ngModel)]="email" autocomplete="username" required /></mat-form-field>
          <mat-form-field class="full"><mat-label>Password</mat-label><input matInput type="password" name="password" [(ngModel)]="password" autocomplete="current-password" required /></mat-form-field>
        }
        @case ('invite') {
          <p class="hint">Choose a password of at least 8 characters.</p>
          <mat-form-field class="full"><mat-label>New password</mat-label><input matInput type="password" name="np" [(ngModel)]="password" autocomplete="new-password" minlength="8" required /></mat-form-field>
          <mat-form-field class="full"><mat-label>Type it again</mat-label><input matInput type="password" name="np2" [(ngModel)]="password2" autocomplete="new-password" required /></mat-form-field>
        }
      }
      @if (error()) { <p class="err">{{ error() }}</p> }
      <button mat-flat-button class="full" type="submit" [disabled]="busy()">{{ step() === 'invite' ? 'Set password' : 'Continue' }}</button>
    </form>
  </div>`,
  styles: `
    .wrap { min-height: 100vh; display: grid; place-items: center; background: #0f1b2d; padding: 16px; box-sizing: border-box; }
    .box { width: min(400px, 100%); background: var(--mat-sys-surface); border-radius: 16px; padding: 28px; box-sizing: border-box; }
    h1 { font: var(--mat-sys-headline-small); margin: 0; } .sub { color: var(--mat-sys-on-surface-variant); margin: 4px 0 20px; }
    .err { color: var(--mat-sys-error); } button + button { margin-top: 8px; }
  `,
})
export class LoginPage {
  private api = inject(Api);
  private router = inject(Router);
  private inviteToken = inject(ActivatedRoute).snapshot.queryParamMap.get('token');
  step = signal<Step>(this.inviteToken ? 'invite' : 'password');
  busy = signal(false);
  error = signal('');
  email = ''; password = ''; password2 = '';

  title() {
    return ({ password: 'Rumfa staff sign-in', invite: 'Welcome to Rumfa Console' } as Record<Step, string>)[this.step()];
  }

  async submit() {
    this.error.set('');
    this.busy.set(true);
    try {
      if (this.step() === 'invite') {
        if (this.password.length < 8) throw new Error('Use at least 8 characters');
        if (this.password !== this.password2) throw new Error('The two passwords are different');
        const r = await this.api.acceptInvite(this.inviteToken!, this.password);
        this.email = r.email;
      }
      await this.api.login(this.email.trim(), this.password);
      await this.router.navigateByUrl('/');
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally { this.busy.set(false); }
  }

}
