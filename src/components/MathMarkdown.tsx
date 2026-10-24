import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { markdownUrlTransform } from "@/lib/markdown-links";
const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [rehypeKatex];
export function MathMarkdown({ content, components }: { content: string; components: Components }) {
  return <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components} urlTransform={markdownUrlTransform}>{content}</ReactMarkdown>;
}
