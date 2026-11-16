/**
 * One app call's audio: joins the LiveKit room with the microphone on and plays the other person.
 * Same file in the agent app and the dashboard.
 */
export class VoiceRoom {
  private room: any = null;
  private audio: HTMLMediaElement[] = [];

  /** Asks for the microphone before a call starts or is answered, so nobody is rung for a call that cannot work. */
  static async checkMic(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot use the microphone, so app calls will not work here. Use a phone call instead.');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
    } catch (e) { throw new Error(micMessage(e)); }
  }

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
    try { await room.localParticipant.setMicrophoneEnabled(true); }
    catch (e) { await room.disconnect().catch(() => undefined); throw new Error(micMessage(e)); }
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

/** What to tell people when the microphone cannot be used. */
function micMessage(e: any): string {
  if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError')
    return 'The microphone is blocked. Allow it for this app (in the browser: the icon by the address bar; on a phone: Settings, Apps, Rumfa, Permissions), then try again.';
  if (e?.name === 'NotFoundError') return 'No microphone was found. Connect one, or use a phone call.';
  if (e?.name === 'NotReadableError') return 'The microphone is in use by another app. Close it and try again.';
  return 'The microphone could not start' + (e?.message ? `: ${e.message}` : '.');
}
