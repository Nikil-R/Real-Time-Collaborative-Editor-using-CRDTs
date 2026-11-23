import { describe, expect, it } from "vitest";
import { percentile, summarize } from "./stats";

describe("percentile (nearest rank)", () => {
  const data = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  it("matches the textbook values", () => {
    expect(percentile(data, 50)).toBe(50);
    expect(percentile(data, 95)).toBe(95);
    expect(percentile(data, 99)).toBe(99);
    expect(percentile(data, 100)).toBe(100);
  });
  it("handles tiny and empty inputs", () => {
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([], 50)).toBeNaN();
    expect(percentile([1, 2], 0)).toBe(1);
  });
});

describe("summarize", () => {
  it("sorts its input and reports the extremes", () => {
    const s = summarize([5, 1, 3]);
    expect(s).toMatchObject({ count: 3, min: 1, max: 5, p50: 3 });
    expect(s.mean).toBeCloseTo(3);
  });
});
