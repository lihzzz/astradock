import { defaultUrlTransform, type UrlTransform } from "react-markdown";
import { isAbsoluteFilePath, parseLocalFileLink, resolvePortableFilePath } from "@shared/lib/file-paths";

/** Only anchors can open local files through the explicit editor IPC handler. */
export const markdownUrlTransform: UrlTransform = (url, key, node) => {
  if (key === "href" && node.tagName === "a" && parseLocalFileLink(url)) return url;
  return defaultUrlTransform(url);
};

/** Resolve against the originating chat, never Electron's installation directory. */
export async function openMarkdownLink(
  href: string,
  cwd: string | undefined,
  bridge: Pick<Window["claude"], "openInEditor" | "openExternal">,
): Promise<{ error?: string }> {
  const target = parseLocalFileLink(href);
  if (!target) return bridge.openExternal(href);
  const filePath = resolvePortableFilePath(target.filePath, cwd);
  if (!isAbsoluteFilePath(filePath)) {
    return { error: "Cannot open a relative file link without a session working directory" };
  }
  return bridge.openInEditor(filePath, target.line);
}
