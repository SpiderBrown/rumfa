import { Component, input, output, signal } from '@angular/core';
import { IonIcon } from '@ionic/angular';

/**
 * A number pad with dots for the PIN (6 digits), as on a phone's lock screen: big keys, no keyboard to pop up.
 * Emits the PIN when the last digit is pressed; the page clears it with reset().
 */
@Component({
  selector: 'app-pin-pad',
  imports: [IonIcon],
  template: `
  <div class="dots" [class.shake]="shake()" aria-hidden="true">
    @for (i of slots; track i) { <span [class.on]="i < value().length"></span> }
  </div>
  <span class="visually-hidden" aria-live="polite">{{ value().length }} of {{ length() }}</span>
  <div class="keys">
    @for (k of keys; track $index) {
      @if (k === '') { <span></span> }
      @else if (k === 'del') { <button type="button" class="key del" (click)="del()" [disabled]="disabled()" aria-label="Delete"><ion-icon name="backspace-outline" /></button> }
      @else { <button type="button" class="key" (click)="press(k)" [disabled]="disabled()">{{ k }}</button> }
    }
  </div>`,
  styles: `
    :host { display: block; }
    .dots { display: flex; justify-content: center; gap: 16px; margin: 18px 0 26px; }
    .dots span { width: 16px; height: 16px; border-radius: 50%; border: 2px solid #8a94a3; }
    .dots span.on { background: var(--r-ink); border-color: var(--r-ink); }
    .dots.shake { animation: sh .35s; } @keyframes sh { 25% { transform: translateX(-8px); } 75% { transform: translateX(8px); } }
    .keys { display: grid; grid-template-columns: repeat(3, 74px); gap: 14px 22px; justify-content: center; }
    .key { width: 74px; height: 64px; border-radius: 32px; border: 1px solid var(--r-line); background: #fff; font: inherit; font-size: 28px; font-weight: 600; color: var(--r-ink); }
    .key:active { background: var(--r-accent-soft); } .key:disabled { opacity: .5; }
    .key.del { font-size: 26px; display: grid; place-items: center; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  `,
})
export class PinPad {
  length = input(6);
  disabled = input(false);
  done = output<string>();
  value = signal('');
  shake = signal(false);
  readonly keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];
  get slots() { return Array.from({ length: this.length() }, (_, i) => i); }
  press(k: string) {
    if (this.value().length >= this.length()) return;
    this.value.update((v) => v + k);
    navigator.vibrate?.(10);
    if (this.value().length === this.length()) this.done.emit(this.value());
  }
  del() { this.value.update((v) => v.slice(0, -1)); }
  /** Clears the dots; wrong = shake them first */
  reset(wrong = false) {
    if (wrong) { this.shake.set(true); setTimeout(() => this.shake.set(false), 400); }
    this.value.set('');
  }
}
