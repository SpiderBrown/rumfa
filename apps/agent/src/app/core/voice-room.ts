/**
 * One app call's audio: joins the LiveKit room with the microphone on and plays the other person.
 * Same file in the agent app and the dashboard.
 */
export class VoiceRoom {
  private room: any = null;
  private audio: HTMLMediaElement[] = [];

  async join(url: string, token: string, onLeft: () => void): Promise<void> {
    const { Room, RoomEvent, Track } = await import('livekit-client');
    const room = new Room({ adaptiveStream: false, dynacast: false });
    room.on(RoomEvent.TrackSubscribed, (track: any) => {
      if (track.kind !== Track.Kind.Audio) return;
      const el = track.attach() as HTMLMediaElement;
      el.style.display = 'none';
      document.body.appendChild(el);
      this.audio.push(el);
    });
    room.on(RoomEvent.Disconnected, () => { this.cleanup(); onLeft(); });
    await room.connect(url, token);
    await room.localParticipant.setMicrophoneEnabled(true);
    this.room = room;
  }

  setMuted(muted: boolean) { void this.room?.localParticipant.setMicrophoneEnabled(!muted); }

  async leave() {
    const r = this.room;
    this.room = null;
    this.cleanup();
    await r?.disconnect().catch(() => undefined);
  }

  private cleanup() { this.audio.forEach((a) => a.remove()); this.audio = []; }
}
