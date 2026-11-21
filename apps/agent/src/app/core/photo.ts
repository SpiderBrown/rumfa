import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';

/** Takes a photo, resized on the phone so it uploads on weak networks (~200 KB). */
export async function takePhoto(from: 'camera' | 'gallery' = 'camera'): Promise<{ blob: Blob; url: string } | null> {
  try {
    const p = await Camera.getPhoto({ quality: 60, width: 1280, resultType: CameraResultType.Uri,
      source: from === 'gallery' ? CameraSource.Photos : CameraSource.Camera, correctOrientation: true });
    if (!p.webPath) return null;
    const blob = await (await fetch(p.webPath)).blob();
    return { blob, url: p.webPath };
  } catch {
    return null;   // cancelled
  }
}

/**
 * A result sheet photo: the full-resolution original (kept on the phone in case the room needs it) and a light copy
 * (~200 KB, 1280 px) that is sent straight away.
 */
export async function takeSheetPhoto(): Promise<{ original: Blob; small: Blob; url: string } | null> {
  try {
    const p = await Camera.getPhoto({ quality: 92, resultType: CameraResultType.Uri, source: CameraSource.Camera, correctOrientation: true });
    if (!p.webPath) return null;
    const original = await (await fetch(p.webPath)).blob();
    return { original, small: await shrink(original, 1280, 0.6), url: p.webPath };
  } catch {
    return null;   // cancelled
  }
}

export async function shrink(blob: Blob, max: number, quality: number): Promise<Blob> {
  try {
    const img = await createImageBitmap(blob);
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return await new Promise<Blob>((res) => c.toBlob((b) => res(b ?? blob), 'image/jpeg', quality));
  } catch {
    return blob;   // can't decode here: send it as it is
  }
}
