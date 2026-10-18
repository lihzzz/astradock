/** Portable path handling for data exchanged by agents, the renderer and Electron. */
export function normalizeFilePathSeparators(value: string): string {
  return value.replace(/\\/g, "/");
}

export function isAbsoluteFilePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]/.test(value);
}

export function resolvePortableFilePath(value: string, cwd?: string | null): string {
  if (!cwd || isAbsoluteFilePath(value)) return value;
  return `${cwd.replace(/[\\/]+$/, "")}/${value}`;
}

export function getFileName(value: string): string {
  return normalizeFilePathSeparators(value).replace(/\/+$/, "").split("/").pop() ?? "";
}

export function getFileDirectory(value: string): string {
  const normalized = normalizeFilePathSeparators(value).replace(/\/+$/, "");
  const slash = normalized.lastIndexOf("/");
  if (slash < 0) return "";
  if (slash === 0) return "/";
  if (slash === 2 && /^[A-Za-z]:/.test(normalized)) return normalized.slice(0, 3);
  return normalized.slice(0, slash);
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Like fileURLToPath, but independent of the executing OS and available in browsers. */
export function fileUrlToPortablePath(value: string): string | null {
  if (CONTROL_CHARACTERS.test(value) || !/^file:/i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "file:" || /%2f|%5c/i.test(url.pathname)) return null;
    const pathname = decodeURIComponent(url.pathname);
    if (CONTROL_CHARACTERS.test(pathname)) return null;
    if (url.hostname && url.hostname !== "localhost") {
      return `\\\\${url.hostname}${pathname.replace(/\//g, "\\")}`;
    }
    return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
  } catch {
    return null;
  }
}

export interface LocalFileLink {
  filePath: string;
  line?: number;
}

function pathWithLine(value: string, decode = true): LocalFileLink | null {
  const match = /^(.*?)(?:#L(\d+)|:(\d+)(?::\d+)?)?$/.exec(value);
  if (!match?.[1]) return null;
  let filePath = match[1];
  if (decode) {
    try { filePath = decodeURIComponent(filePath); } catch { /* An unescaped percent can be part of a filename. */ }
  }
  if (CONTROL_CHARACTERS.test(filePath)) return null;
  const line = Number(match[2] ?? match[3]);
  return { filePath, ...(line > 0 && Number.isSafeInteger(line) ? { line } : {}) };
}

/** Chat-relative links refer to workspace files; schemes, fragments and web URLs stay URLs. */
export function parseLocalFileLink(href: string): LocalFileLink | null {
  if (!href || CONTROL_CHARACTERS.test(href)) return null;
  if (/^file:/i.test(href)) {
    const filePath = fileUrlToPortablePath(href);
    if (!filePath) return null;
    const hashLine = /^#L(\d+)$/i.exec(new URL(href).hash)?.[1];
    const line = hashLine ? Number(hashLine) : undefined;
    const target = pathWithLine(filePath, false);
    return target ? { ...target, ...(line && Number.isSafeInteger(line) ? { line } : {}) } : null;
  }
  if (!/^[A-Za-z]:[\\/]/.test(href) && !href.startsWith("\\\\")
    && !(href.startsWith("/") && !href.startsWith("//"))
    && (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href) || /^[#?]/.test(href) || href.startsWith("//"))) return null;

  return pathWithLine(href);
}
