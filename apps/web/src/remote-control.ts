import { remoteControlEventSchema } from "@remote-support/contracts";

export interface NormalizedPoint {
  x: number;
  y: number;
}

export function getNormalizedVideoPoint(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  videoWidth: number,
  videoHeight: number,
): NormalizedPoint | null {
  if (
    rect.width <= 0
    || rect.height <= 0
    || videoWidth <= 0
    || videoHeight <= 0
    || !Number.isFinite(clientX)
    || !Number.isFinite(clientY)
  ) {
    return null;
  }

  const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight);
  const displayedWidth = videoWidth * scale;
  const displayedHeight = videoHeight * scale;
  const left = rect.left + (rect.width - displayedWidth) / 2;
  const top = rect.top + (rect.height - displayedHeight) / 2;
  const x = (clientX - left) / displayedWidth;
  const y = (clientY - top) / displayedHeight;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;

  return { x, y };
}

export function isAllowedRemoteKey(code: string): boolean {
  return remoteControlEventSchema.safeParse({ type: "key", action: "down", code }).success;
}

export function createRemoteControlMessage(value: unknown): string | null {
  const parsed = remoteControlEventSchema.safeParse(value);
  return parsed.success ? JSON.stringify(parsed.data) : null;
}
