import assert from "node:assert/strict";
import test from "node:test";

import { BoundedToolRegistry, WebMcpBridge } from "../app/webmcp.js";

function definition(name, execute = async () => name) {
  return {
    name,
    title: name,
    description: `Test tool ${name}`,
    inputSchema: {
      type: "object",
      properties: { value: { type: "number" } },
      additionalProperties: false,
    },
    execute,
  };
}

test("the bounded registry replaces its surface and rejects tools that are no longer exposed", async () => {
  const registry = new BoundedToolRegistry();
  const notifications = [];
  const unsubscribe = registry.subscribe((tools) => notifications.push(tools));
  const originalInput = { value: 7 };
  let observedSignal;

  registry.setDefinitions([
    definition("first", async (input, { signal }) => {
      observedSignal = signal;
      input.value = 99;
      return "first-result";
    }),
  ]);

  assert.deepEqual(registry.list().map(({ name }) => name), ["first"]);
  assert.equal("execute" in registry.list()[0], false);
  assert.equal(await registry.invoke("first", originalInput), "first-result");
  assert.deepEqual(originalInput, { value: 7 });
  assert.ok(observedSignal instanceof AbortSignal);
  assert.equal(observedSignal.aborted, false);

  registry.setDefinitions([definition("second")]);
  await assert.rejects(
    registry.invoke("first", {}),
    (error) => error?.code === "TOOL_NOT_EXPOSED",
  );
  assert.equal(await registry.invoke("second", {}), "second");
  assert.equal(notifications.length, 2);

  unsubscribe();
  registry.setDefinitions([]);
  assert.equal(notifications.length, 2);
});

test("registry metadata snapshots are detached from live definitions", () => {
  const registry = new BoundedToolRegistry();
  registry.setDefinitions([definition("safe")]);

  const snapshot = registry.list();
  snapshot[0].name = "mutated";
  snapshot[0].inputSchema.properties.value.type = "string";

  assert.equal(registry.list()[0].name, "safe");
  assert.equal(registry.list()[0].inputSchema.properties.value.type, "number");
});

test("removing a tool aborts its in-flight invocation", async () => {
  const registry = new BoundedToolRegistry();
  let observedSignal;
  registry.setDefinitions([
    definition("deferred", async (input, { signal }) => {
      observedSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            const error = new Error("tool revoked");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    }),
  ]);

  const invocation = registry.invoke("deferred", {});
  assert.equal(observedSignal.aborted, false);
  registry.setDefinitions([]);

  assert.equal(observedSignal.aborted, true);
  await assert.rejects(invocation, (error) => error?.name === "AbortError");
});

test("an unsupported bridge is an explicit no-op", async () => {
  const bridge = new WebMcpBridge(null);

  assert.equal(bridge.supported, false);
  assert.deepEqual(await bridge.sync([definition("unused")]), {
    supported: false,
    registered: [],
  });
  assert.equal(bridge.lastError, null);
  bridge.dispose();
});

test("resync aborts old registrations and dispose aborts the current surface", async () => {
  const calls = [];
  const modelContext = {
    async registerTool(tool, { signal }) {
      calls.push({ name: tool.name, signal });
    },
  };
  const bridge = new WebMcpBridge(modelContext);

  assert.deepEqual(await bridge.sync([definition("one"), definition("two")]), {
    supported: true,
    registered: ["one", "two"],
  });
  assert.deepEqual(calls.map(({ name }) => name), ["one", "two"]);
  assert.ok(calls.slice(0, 2).every(({ signal }) => !signal.aborted));

  assert.deepEqual(await bridge.sync([definition("three")]), {
    supported: true,
    registered: ["three"],
  });
  assert.ok(calls.slice(0, 2).every(({ signal }) => signal.aborted));
  assert.equal(calls[2].signal.aborted, false);

  bridge.dispose();
  assert.equal(calls[2].signal.aborted, true);
});

test("a partial registration failure aborts the whole attempted surface", async () => {
  const failure = new Error("registration failed");
  const calls = [];
  const modelContext = {
    async registerTool(tool, { signal }) {
      calls.push({ name: tool.name, signal });
      if (tool.name === "bad") throw failure;
    },
  };
  const bridge = new WebMcpBridge(modelContext);

  const result = await bridge.sync([definition("good"), definition("bad"), definition("never")]);
  assert.equal(result.supported, true);
  assert.deepEqual(result.registered, []);
  assert.equal(result.error, failure);
  assert.equal(bridge.lastError, failure);
  assert.deepEqual(calls.map(({ name }) => name), ["good", "bad"]);
  assert.ok(calls.every(({ signal }) => signal.aborted));
});

test("an obsolete sync cannot abort or poison the newest registration generation", async () => {
  const calls = [];
  const modelContext = {
    registerTool(tool, { signal }) {
      calls.push({ name: tool.name, signal });
      if (tool.name !== "old") return Promise.resolve();

      return new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            const error = new Error("obsolete registration aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    },
  };
  const bridge = new WebMcpBridge(modelContext);

  const obsoleteSync = bridge.sync([definition("old")]);
  await Promise.resolve();
  const currentResult = await bridge.sync([definition("current")]);
  const obsoleteResult = await obsoleteSync;

  assert.deepEqual(currentResult, {
    supported: true,
    registered: ["current"],
  });
  assert.equal(obsoleteResult.supported, true);
  assert.deepEqual(obsoleteResult.registered, []);
  assert.equal(bridge.lastError, null);
  assert.equal(calls.find(({ name }) => name === "old").signal.aborted, true);
  assert.equal(calls.find(({ name }) => name === "current").signal.aborted, false);
});
