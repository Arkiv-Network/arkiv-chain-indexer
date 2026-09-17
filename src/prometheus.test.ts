import { describe, expect, test } from "bun:test";
import { Counter, Gauge, Histogram, Registry, escapeLabelValue, formatValue } from "./prometheus";

describe("Counter", () => {
  test("accumulates per label set and renders exposition lines", () => {
    const counter = new Counter("requests_total", "Requests.", ["route", "status"]);
    counter.inc({ route: "/blocks", status: "200" });
    counter.inc({ route: "/blocks", status: "200" }, 2);
    counter.inc({ route: "/ranges", status: "500" });

    expect(counter.get({ route: "/blocks", status: "200" })).toBe(3);
    expect(counter.get({ route: "/nope", status: "200" })).toBe(0);
    expect(counter.render()).toBe(
      [
        "# HELP requests_total Requests.",
        "# TYPE requests_total counter",
        'requests_total{route="/blocks",status="200"} 3',
        'requests_total{route="/ranges",status="500"} 1',
      ].join("\n"),
    );
  });

  test("rejects negative increments and missing labels", () => {
    const counter = new Counter("c", "help", ["a"]);
    expect(() => counter.inc({ a: "x" }, -1)).toThrow(/cannot decrease/);
    expect(() => counter.inc()).toThrow(/requires label "a"/);
  });

  test("assign overwrites a series with an external total", () => {
    const counter = new Counter("hits_total", "help", ["cache"]);
    counter.assign({ cache: "list" }, 10);
    counter.assign({ cache: "list" }, 12);
    expect(counter.get({ cache: "list" })).toBe(12);
  });

  test("validates metric and label names", () => {
    expect(() => new Counter("bad-name", "help")).toThrow(/Invalid metric name/);
    expect(() => new Counter("ok", "help", ["__reserved"])).toThrow(/Invalid label name/);
    expect(() => new Counter("ok", "help", ["bad-label"])).toThrow(/Invalid label name/);
  });
});

describe("Gauge", () => {
  test("set, inc, dec and remove", () => {
    const gauge = new Gauge("in_flight", "help", ["route"]);
    gauge.inc({ route: "/a" });
    gauge.inc({ route: "/a" });
    gauge.dec({ route: "/a" });
    gauge.set({ route: "/b" }, 7);
    expect(gauge.get({ route: "/a" })).toBe(1);
    expect(gauge.get({ route: "/b" })).toBe(7);
    gauge.remove({ route: "/b" });
    expect(gauge.render()).toBe(
      ["# HELP in_flight help", "# TYPE in_flight gauge", 'in_flight{route="/a"} 1'].join("\n"),
    );
  });

  test("unlabelled gauges render a bare sample", () => {
    const gauge = new Gauge("head_block", "help");
    gauge.set(undefined, 42);
    expect(gauge.render()).toContain("\nhead_block 42");
  });
});

describe("Histogram", () => {
  test("renders cumulative buckets, +Inf, sum and count", () => {
    const histogram = new Histogram("latency_seconds", "help", ["route"], [0.1, 1]);
    histogram.observe({ route: "/a" }, 0.05);
    histogram.observe({ route: "/a" }, 0.5);
    histogram.observe({ route: "/a" }, 5);

    expect(histogram.get({ route: "/a" })).toEqual({ count: 3, sum: 5.55 });
    expect(histogram.render()).toBe(
      [
        "# HELP latency_seconds help",
        "# TYPE latency_seconds histogram",
        'latency_seconds_bucket{route="/a",le="0.1"} 1',
        'latency_seconds_bucket{route="/a",le="1"} 2',
        'latency_seconds_bucket{route="/a",le="+Inf"} 3',
        'latency_seconds_sum{route="/a"} 5.55',
        'latency_seconds_count{route="/a"} 3',
      ].join("\n"),
    );
  });

  test("sorts buckets and refuses the reserved le label", () => {
    const histogram = new Histogram("h", "help", [], [5, 1, 2]);
    expect(histogram.buckets).toEqual([1, 2, 5]);
    expect(() => new Histogram("h", "help", ["le"])).toThrow(/reserved label/);
    expect(() => new Histogram("h", "help", [], [])).toThrow(/at least one bucket/);
  });

  test("startTimer observes elapsed seconds", async () => {
    const histogram = new Histogram("h", "help", [], [10]);
    const stop = histogram.startTimer();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const seconds = stop();
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThan(1);
    expect(histogram.get().count).toBe(1);
  });
});

describe("Registry", () => {
  test("renders every metric, runs collectors first, and ends with a newline", async () => {
    const registry = new Registry();
    const counter = registry.counter("a_total", "A.");
    const gauge = registry.gauge("b", "B.");
    counter.inc();
    registry.collect(() => gauge.set(undefined, 3));
    registry.collect(async () => {
      await Promise.resolve();
      gauge.inc(undefined, 1);
    });

    const text = await registry.render();
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain("# TYPE a_total counter\na_total 1");
    expect(text).toContain("# TYPE b gauge\nb 4");
  });

  test("a failing collector does not blank the scrape", async () => {
    const registry = new Registry();
    const gauge = registry.gauge("g", "help");
    gauge.set(undefined, 1);
    registry.collect(() => {
      throw new Error("boom");
    });
    const text = await registry.render();
    expect(text).toContain("g 1");
  });

  test("rejects duplicate names and supports unregistering collectors", async () => {
    const registry = new Registry();
    registry.counter("dup", "help");
    expect(() => registry.gauge("dup", "help")).toThrow(/already registered/);

    let calls = 0;
    const stop = registry.collect(() => {
      calls += 1;
    });
    await registry.render();
    stop();
    await registry.render();
    expect(calls).toBe(1);
  });

  test("resetAll clears every series", async () => {
    const registry = new Registry();
    const counter = registry.counter("c_total", "help", ["x"]);
    counter.inc({ x: "1" });
    registry.resetAll();
    expect(counter.get({ x: "1" })).toBe(0);
  });
});

describe("formatting", () => {
  test("escapes label values", () => {
    expect(escapeLabelValue('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
  });

  test("formats special values", () => {
    expect(formatValue(Number.POSITIVE_INFINITY)).toBe("+Inf");
    expect(formatValue(Number.NEGATIVE_INFINITY)).toBe("-Inf");
    expect(formatValue(Number.NaN)).toBe("NaN");
    expect(formatValue(1.5)).toBe("1.5");
  });
});
