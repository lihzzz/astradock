import { createContext, useContext } from "react";
import type { Components } from "react-markdown";
import { toast } from "sonner";
import { openMarkdownLink } from "@/lib/markdown-links";
import { reportError } from "@/lib/analytics/analytics";

/** Per-pane cwd, so memoized message rows never borrow another session's workspace. */
export const ChatFileCwdContext = createContext<string | undefined>(undefined);

export const MarkdownFileLink: Components["a"] = ({ href, children, node: _node, ...props }) => {
  const cwd = useContext(ChatFileCwdContext);
  return (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        if (!href || href.startsWith("#")) return;
        event.preventDefault();
        void openMarkdownLink(href, cwd, window.claude).then((result) => {
          if (result.error) toast.error(result.error);
        }).catch((error: unknown) => {
          toast.error(reportError("CHAT:OPEN_LINK_ERR", error));
        });
      }}
    >
      {children}
    </a>
  );
};
