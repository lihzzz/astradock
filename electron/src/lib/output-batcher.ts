/** Ordered PTY batches. flush() is also the snapshot/exit consistency barrier. */
export class OutputBatcher {
  private chunks: string[] = [];
  private chars = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly send: (data: string) => void, private readonly delay = 16, private readonly maxChars = 64 * 1024) {}
  push(data: string): void {
    if (!data) return;
    this.chunks.push(data); this.chars += data.length;
    if (this.chars >= this.maxChars) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), this.delay);
  }
  flush(): void {
    clearTimeout(this.timer); this.timer = undefined;
    if (!this.chars) return;
    const text = this.chunks.join(""); this.chunks = []; this.chars = 0;
    this.send(text);
  }
  dispose(): void { clearTimeout(this.timer); this.timer = undefined; this.chunks = []; this.chars = 0; }
}
