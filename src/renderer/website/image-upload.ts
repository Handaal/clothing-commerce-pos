// Shared image upload for the Website desk (SDK 0.53): the server chooses the destination (an upload
// intent), the till PUTs the bytes to the signed URL, then the caller saves { bucket, path }.

export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

export class ImageUploadError extends Error {
  constructor(
    readonly reason: "type" | "storage" | "upload",
    readonly status?: number,
  ) {
    super(reason);
    this.name = "ImageUploadError";
  }
}

export interface UploadIntent {
  bucket: string;
  path: string;
  contentType: string;
  uploadUrl: string | null;
}

export async function uploadImage(
  file: File,
  createIntent: (body: { contentType: ImageType; fileName?: string }) => Promise<UploadIntent>,
  fetchImpl: typeof globalThis.fetch,
): Promise<{ bucket: string; path: string }> {
  const contentType = file.type as ImageType;
  if (!IMAGE_TYPES.includes(contentType)) throw new ImageUploadError("type");
  const intent = await createIntent({
    contentType,
    ...(file.name ? { fileName: file.name.slice(0, 200) } : {}),
  });
  if (!intent.uploadUrl) throw new ImageUploadError("storage");
  const response = await fetchImpl(intent.uploadUrl, {
    method: "PUT",
    headers: { "content-type": intent.contentType },
    body: file,
  });
  if (!response.ok) throw new ImageUploadError("upload", response.status);
  return { bucket: intent.bucket, path: intent.path };
}

/** Translation key for an upload failure (falls back to the shared SDK error wording). */
export function uploadErrorKey(error: unknown): string | null {
  if (!(error instanceof ImageUploadError)) return null;
  return error.reason === "type"
    ? "website.home.imageType"
    : error.reason === "storage"
      ? "website.home.storageUnavailable"
      : "website.img.uploadFailed";
}
