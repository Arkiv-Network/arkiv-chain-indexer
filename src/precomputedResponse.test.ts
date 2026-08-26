import { describe, expect, test } from "bun:test";
import { PrecomputedResponse } from "./precomputedResponse";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeCompute() {
  let calls = 0;
  const compute = async () => {
    calls += 1;
    return { status: 200, body: `body-${calls}` };
  };
  return { compute, calls: () => calls };
}

describe("PrecomputedResponse", () => {
  test("start computes once and get() serves it without recomputing", async () => {
    const { compute, calls } = makeCompute();
    const pre = new PrecomputedResponse(compute, { refreshIntervalMs: 0 });
    expect(pre.get()).toBeNull();

    await pre.start();
    expect(pre.get()).toEqual({ status: 200, body: "body-1" });
    expect(pre.get()).toEqual({ status: 200, body: "body-1" });
    expect(calls()).toBe(1);
    pre.stop();
  });

  test("markDirty recomputes immediately once the coalescing window passed", async () => {
    const { compute, calls } = makeCompute();
    const pre = new PrecomputedResponse(compute, { minIntervalMs: 0, refreshIntervalMs: 0 });
    await pre.start();

    pre.markDirty();
    await sleep(5);
    expect(calls()).toBe(2);
    expect(pre.get()).toEqual({ status: 200, body: "body-2" });
    pre.stop();
  });

  test("a burst of markDirty calls coalesces into one trailing recompute", async () => {
    const { compute, calls } = makeCompute();
    const pre = new PrecomputedResponse(compute, { minIntervalMs: 40, refreshIntervalMs: 0 });
    await pre.start();

    for (let i = 0; i < 5; i += 1) pre.markDirty();
    expect(calls()).toBe(1); // still inside the window
    await sleep(80);
    expect(calls()).toBe(2); // one trailing recompute
    pre.stop();
  });

  test("markDirty during a running compute queues exactly one follow-up", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const compute = async () => {
      calls += 1;
      if (calls === 1) await gate;
      return { status: 200, body: `body-${calls}` };
    };
    const pre = new PrecomputedResponse(compute, { minIntervalMs: 0, refreshIntervalMs: 0 });
    const started = pre.start();
    pre.markDirty();
    pre.markDirty();
    pre.markDirty();
    release();
    await started;
    await sleep(10);
    expect(calls).toBe(2);
    pre.stop();
  });

  test("the periodic refresh keeps recomputing without events", async () => {
    const { compute, calls } = makeCompute();
    const pre = new PrecomputedResponse(compute, { minIntervalMs: 0, refreshIntervalMs: 15 });
    await pre.start();
    await sleep(80);
    expect(calls()).toBeGreaterThanOrEqual(3);
    pre.stop();
  });

  test("a failed recompute keeps the previous response and reports the error", async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const compute = async () => {
      calls += 1;
      if (calls === 2) throw new Error("db down");
      return { status: 200, body: `body-${calls}` };
    };
    const pre = new PrecomputedResponse(compute, {
      minIntervalMs: 0,
      refreshIntervalMs: 0,
      onError: (error) => errors.push(error),
    });
    await pre.start();
    pre.markDirty();
    await sleep(5);

    expect(pre.get()).toEqual({ status: 200, body: "body-1" });
    expect(errors).toHaveLength(1);

    pre.markDirty();
    await sleep(5);
    expect(pre.get()).toEqual({ status: 200, body: "body-3" });
    pre.stop();
  });

  test("a failing initial compute leaves get() null without throwing from start", async () => {
    const errors: unknown[] = [];
    const pre = new PrecomputedResponse(
      async () => {
        throw new Error("boot failure");
      },
      { refreshIntervalMs: 0, onError: (error) => errors.push(error) },
    );
    await pre.start();
    expect(pre.get()).toBeNull();
    expect(errors).toHaveLength(1);
    pre.stop();
  });

  test("stop halts refreshes and pending recomputes", async () => {
    const { compute, calls } = makeCompute();
    const pre = new PrecomputedResponse(compute, { minIntervalMs: 30, refreshIntervalMs: 10 });
    await pre.start();
    pre.markDirty(); // schedules a trailing recompute
    pre.stop();
    const settled = calls();
    await sleep(60);
    expect(calls()).toBe(settled);
    pre.markDirty();
    await sleep(10);
    expect(calls()).toBe(settled);
  });
});
