import { useEffect, useRef, useState } from "react";

/** Bound long-document parsing work without debouncing indefinitely during a stream.
 * Completed responses and short messages are always displayed immediately. */
export function useThrottledStreamingText(text: string, streaming: boolean): string {
  const [displayed, setDisplayed] = useState(text);
  const lastUpdate = useRef(0);
  const delay = text.length >= 20_000 ? 120 : text.length >= 5_000 ? 64 : 0;
  useEffect(() => {
    if (!streaming || !delay) { lastUpdate.current = Date.now(); setDisplayed(text); return; }
    const timer = setTimeout(() => {
      lastUpdate.current = Date.now();
      setDisplayed(text);
    }, Math.max(0, delay - (Date.now() - lastUpdate.current)));
    return () => clearTimeout(timer);
  }, [text, streaming, delay]);
  return streaming && delay && text.startsWith(displayed) ? displayed : text;
}
