/**
 * Tracks which server `seq` numbers have been received.
 *
 * Server seq numbers are gap-free (docs/05-DATABASE.md section 3), but
 * broadcasts can arrive out of order. The watermark is the largest S such that
 * every seq from 1..S has been received (or is covered by a snapshot). It is
 * the only value that is safe to send as `last_seq` when reconnecting.
 */
export class SeqTracker {
  private watermark = 0;
  private ahead = new Set<number>();
  private highest = 0;

  constructor(start = 0) {
    this.watermark = start;
    this.highest = start;
  }

  get value(): number {
    return this.watermark;
  }

  /** Highest seq seen, even if lower ones are still missing. */
  get highestSeen(): number {
    return this.highest;
  }

  /** True while some seq below the highest seen is still missing. */
  get hasGap(): boolean {
    return this.ahead.size > 0;
  }

  /** Jump forward (a snapshot covers everything up to `seq`). */
  advanceTo(seq: number): void {
    if (seq <= this.watermark) return;
    this.watermark = seq;
    this.highest = Math.max(this.highest, seq);
    for (const s of this.ahead) if (s <= seq) this.ahead.delete(s);
    this.drain();
  }

  observe(seq: number): void {
    if (seq > this.highest) this.highest = seq;
    if (seq <= this.watermark) return;
    if (seq === this.watermark + 1) {
      this.watermark = seq;
      this.drain();
    } else {
      this.ahead.add(seq);
    }
  }

  private drain(): void {
    while (this.ahead.has(this.watermark + 1)) {
      this.ahead.delete(this.watermark + 1);
      this.watermark += 1;
    }
  }
}
