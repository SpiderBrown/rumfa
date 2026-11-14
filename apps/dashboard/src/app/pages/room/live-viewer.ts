import { Component, ElementRef, OnDestroy, effect, inject, input, signal, viewChild } from '@angular/core';
import { Supa } from '../../core/supabase';

/** Plays the one-way video an agent publishes for a live-view request (LiveKit). */
@Component({
  selector: 'app-live-viewer',
  template: `<video #v autoplay playsinline muted controls class="v"></video>
             <div class="s">{{ state() }}</div>`,
  styles: `.v { width: 100%; background: #000; border-radius: 8px; aspect-ratio: 3/4; } .s { font-size: 12px; color: var(--mat-sys-on-surface-variant); }`,
})
export class LiveViewer implements OnDestroy {
  requestId = input.required<string>();
  private supa = inject(Supa);
  private video = viewChild.required<ElementRef<HTMLVideoElement>>('v');
  state = signal('Connecting…');
  private room: any;

  constructor() {
    effect(() => { void this.connect(this.requestId()); });
  }

  private async connect(id: string) {
    try {
      const { Room, RoomEvent, Track } = await import('livekit-client');
      const { url, token } = await this.supa.fn<{ url: string; token: string }>('live-view', { action: 'view', request_id: id });
      this.room = new Room({ adaptiveStream: true });
      this.room.on(RoomEvent.TrackSubscribed, (track: any) => {
        if (track.kind === Track.Kind.Video) { track.attach(this.video().nativeElement); this.state.set('Live'); }
      });
      this.room.on(RoomEvent.Disconnected, () => this.state.set('Ended'));
      await this.room.connect(url, token);
      this.state.set('Waiting for the agent’s camera…');
    } catch (e) {
      this.state.set(`Could not connect: ${(e as Error).message}`);
    }
  }

  ngOnDestroy() { void this.room?.disconnect(); }
}
