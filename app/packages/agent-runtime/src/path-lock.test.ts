import { describe, expect, it } from "vitest";
import { normalizeLockPath, PathMutex } from "./path-lock.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("normalizeLockPath", () => {
  it("compares spellings of the same path equal", () => {
    expect(normalizeLockPath("./src/App.tsx")).toBe("src/app.tsx");
    expect(normalizeLockPath("src\\App.tsx")).toBe("src/app.tsx");
    expect(normalizeLockPath("src/app.tsx/")).toBe("src/app.tsx");
    expect(normalizeLockPath(undefined)).toBe("");
  });
});

describe("PathMutex", () => {
  it("serializes the same path and keeps other paths concurrent", async () => {
    const mutex = new PathMutex();
    const order: string[] = [];
    const first = deferred();
    const other = deferred();

    const a = mutex.run("src/app.ts", async () => {
      order.push("a:start");
      await first.promise;
      order.push("a:end");
    });
    const b = mutex.run("./src/app.ts", async () => {
      order.push("b:start");
      order.push("b:end");
    });
    const c = mutex.run("src/other.ts", async () => {
      order.push("c:start");
      await other.promise;
      order.push("c:end");
    });

    // `b` waits on `a`; `c` does not wait on either.
    expect(order).toEqual(["a:start", "c:start"]);
    other.resolve();
    await c;
    expect(order).toEqual(["a:start", "c:start", "c:end"]);
    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual([
      "a:start",
      "c:start",
      "c:end",
      "a:end",
      "b:start",
      "b:end",
    ]);
    expect(mutex.busy).toBe(false);
  });

  it("lets the queue continue after a holder throws", async () => {
    const mutex = new PathMutex();
    const failing = mutex.run("a.ts", async () => {
      throw new Error("write failed");
    });
    const next = mutex.run("a.ts", async () => "ok");

    await expect(failing).rejects.toThrow("write failed");
    await expect(next).resolves.toBe("ok");
    expect(mutex.busy).toBe(false);
  });

  it("does not lock an empty path", async () => {
    const mutex = new PathMutex();
    const held = deferred();
    const first = mutex.run("", async () => {
      await held.promise;
      return 1;
    });
    await expect(mutex.run("", async () => 2)).resolves.toBe(2);
    held.resolve();
    await expect(first).resolves.toBe(1);
  });
});
