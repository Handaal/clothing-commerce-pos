import path from "node:path";

export const PRODUCTION_RENDERER_ORIGIN = "http://127.0.0.1:4173";

export function isAllowedRendererNavigation(destination: string, rendererUrl: string): boolean {
  try {
    return new URL(destination).origin === new URL(rendererUrl).origin;
  } catch {
    return false;
  }
}

export function rendererFilePath(rendererRoot: string, requestPath: string): string | null {
  const url = new URL(requestPath, PRODUCTION_RENDERER_ORIGIN);
  if (url.origin !== PRODUCTION_RENDERER_ORIGIN) return null;

  const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
  const root = path.resolve(rendererRoot);
  const candidate = path.resolve(root, relativePath);
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return candidate;
}
