import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';

/** Takes a photo, resized on the phone so it uploads on weak networks (~200 KB). */
export async function takePhoto(): Promise<{ blob: Blob; url: string } | null> {
  try {
    const p = await Camera.getPhoto({ quality: 60, width: 1280, resultType: CameraResultType.Uri, source: CameraSource.Camera, correctOrientation: true });
    if (!p.webPath) return null;
    const blob = await (await fetch(p.webPath)).blob();
    return { blob, url: p.webPath };
  } catch {
    return null;   // cancelled
  }
}
