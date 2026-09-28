import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../plugin/ui.html", import.meta.url), "utf8").match(/<script>([\s\S]*?)<\/script>/)[1];
const settle = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Virtual time makes the real 8s/12s protocol deadlines testable without sleeps
// or timing tolerances that mask a second polling loop on a busy machine.
function createPlugin(plans = []) {
  let now = 0, nextTimer = 0;
  const timers = new Map(), elements = new Map(), events = {};
  const metrics = { polls: [], active: 0, maximum: 0, aborts: 0, statuses: [], commands: [], responses: [] };
  function schedule(callback, delay) {
    const id = ++nextTimer;
    timers.set(id, { at: now + delay, callback });
    return id;
  }
  function element(id) {
    let text = "";
    return {
      children: [], className: "", scrollHeight: 0,
      get textContent() { return text; },
      set textContent(value) { text = value; if (id === "status-text") metrics.statuses.push(value); },
      appendChild(child) { this.children.push(child); },
      removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
      get firstChild() { return this.children[0]; },
    };
  }
  class ClockDate extends Date { static now() { return now; } }
  const context = vm.createContext({
    document: {
      visibilityState: "visible",
      getElementById(id) { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); },
      createElement: () => element("log-line"),
      addEventListener(type, listener) { events[type] = listener; },
    },
    window: {}, parent: { postMessage(message) { metrics.commands.push(message.pluginMessage); } },
    AbortController, AbortSignal, Date: ClockDate, console,
    setTimeout: schedule, clearTimeout: id => timers.delete(id), prompt() {}, alert() {},
    fetch(url, request = {}) {
      if (!url.includes("/poll")) {
        metrics.responses.push({ url, body: JSON.parse(request.body) });
        return Promise.resolve({ ok: true });
      }
      const plan = plans[metrics.polls.length] || {};
      metrics.polls.push({ url, signal: request.signal });
      if (plan.error) return Promise.reject(plan.error);
      metrics.active++;
      metrics.maximum = Math.max(metrics.maximum, metrics.active);
      return new Promise((resolve, reject) => {
        let done = false;
        function finish(callback) {
          if (done) return;
          done = true;
          metrics.active--;
          request.signal.removeEventListener("abort", abort);
          callback();
        }
        const timer = plan.hang ? null : schedule(() => finish(() => resolve({
          ok: plan.status === undefined || plan.status === 200,
          status: plan.status || 200,
          json: async () => {
            if (plan.jsonError) throw plan.jsonError;
            if (plan.bodyGate) return plan.bodyGate.promise;
            return plan.body === undefined ? { requests: [], mode: "ready" } : plan.body;
          },
        })), plan.delay === undefined ? 8000 : plan.delay);
        function abort() {
          timers.delete(timer);
          finish(() => { metrics.aborts++; reject(new DOMException("Aborted", "AbortError")); });
        }
        request.signal.addEventListener("abort", abort, { once: true });
      });
    },
  });
  vm.runInContext(source, context);
  async function advance(ms) {
    const until = now + ms;
    await settle();
    let steps = 0;
    while (true) {
      const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      assert.ok(++steps < 1000, "Polling must yield between requests");
      const [id, timer] = due;
      now = timer.at;
      timers.delete(id);
      timer.callback();
      await settle();
    }
    now = until;
    await settle();
  }
  return { context, events, metrics, advance };
}

test("healthy idle polls keep a single owner and complete before their timeout", async () => {
  const plugin = createPlugin();
  await plugin.advance(17000);
  assert.equal(plugin.metrics.maximum, 1);
  assert.equal(plugin.metrics.polls.length, 3);
  assert.equal(plugin.metrics.aborts, 0);
  assert.equal(plugin.context.consecutiveErrors, 0);
});

test("first recovery poll waits long enough for the server's 8-second response", async () => {
  const plugin = createPlugin([{ error: new TypeError("Network failure") }]);
  await plugin.advance(9000);
  assert.ok(plugin.metrics.statuses.includes("Connected"));
  assert.equal(plugin.context.consecutiveErrors, 0);
  assert.equal(plugin.metrics.aborts, 0);
});

test("a hung request times out and the next request recovers", async () => {
  const plugin = createPlugin([{ hang: true }]);
  await plugin.advance(21000);
  assert.equal(plugin.metrics.aborts, 1);
  assert.equal(plugin.metrics.maximum, 1);
  assert.ok(plugin.metrics.statuses.includes("Connected"));
  assert.equal(plugin.context.consecutiveErrors, 0);
});

test("returning to a healthy visible tab leaves its long poll running", async () => {
  const plugin = createPlugin();
  await plugin.advance(9000);
  const current = plugin.context.activeAbortController;
  plugin.events.visibilitychange();
  await plugin.advance(1000);
  assert.equal(plugin.context.activeAbortController, current);
  assert.equal(plugin.metrics.aborts, 0);
  assert.equal(plugin.metrics.polls.length, 2);
});

test("rapid reconnect invalidates old owners and coalesces restart timers", async () => {
  const plugin = createPlugin();
  await plugin.advance(1000);
  plugin.context.reconnect();
  await plugin.advance(100);
  plugin.context.reconnect();
  await plugin.advance(9000);
  assert.equal(plugin.metrics.maximum, 1);
  assert.equal(plugin.metrics.aborts, 1);
  assert.ok(plugin.metrics.statuses.includes("Connected"));
  assert.equal(plugin.metrics.statuses.some(status => status.startsWith("Waiting")), false);
});

test("a sleeping old loop cannot resume after reconnect", async () => {
  const plugin = createPlugin();
  await plugin.advance(8150);
  plugin.context.reconnect();
  await plugin.advance(9000);
  assert.equal(plugin.metrics.maximum, 1);
  assert.equal(plugin.metrics.polls.length, 3);
  assert.equal(plugin.metrics.aborts, 0);
});

test("late decoded commands keep their original response bridge after a port switch", async () => {
  const bodyGate = deferred();
  const plugin = createPlugin([{ bodyGate }]);
  await plugin.advance(8000);
  plugin.context.setPort(40000);
  await plugin.advance(4000);
  // The obsolete request's 12s timer cannot abort the new request at port 40000.
  assert.equal(plugin.metrics.polls[1].signal.aborted, false);
  const request = { id: "old-request", operation: "status", params: {} };
  bodyGate.resolve({ requests: [request], mode: "ready" });
  await settle();
  assert.equal(plugin.metrics.commands.length, 1);
  assert.equal(plugin.metrics.statuses.at(-1), "Reconnecting...");
  await plugin.context.window.onmessage({ data: { pluginMessage: { id: request.id, operation: request.operation, success: true, data: {} } } });
  assert.equal(plugin.metrics.responses[0].url, "http://localhost:38451/response");
  assert.equal(plugin.metrics.responses[0].body.id, request.id);
  await plugin.advance(5000);
  assert.equal(plugin.metrics.commands.length, 1);
  assert.equal(plugin.metrics.maximum, 1);
});

test("HTTP errors, malformed JSON, and invalid envelopes recover without duplicate loops", async () => {
  const plugin = createPlugin([
    { status: 503, delay: 0 },
    { jsonError: new SyntaxError("Invalid JSON"), delay: 0 },
    { body: {}, delay: 0 },
  ]);
  await plugin.advance(15000);
  assert.equal(plugin.context.consecutiveErrors, 0);
  assert.ok(plugin.metrics.statuses.includes("Connected"));
  assert.equal(plugin.metrics.maximum, 1);
  assert.equal(plugin.metrics.aborts, 0);
});

test("layout warnings and control messages do not count as failed writes or send orphan responses", async () => {
  const plugin = createPlugin();
  await plugin.context.window.onmessage({ data: { pluginMessage: { type: "log", message: "Auto-layout controls child placement" } } });
  await plugin.context.window.onmessage({ data: { pluginMessage: { type: "control" } } });
  await plugin.context.window.onmessage({ data: null });
  await plugin.context.window.onmessage({ data: { pluginMessage: { id: "unknown", success: false, error: "not a pending request" } } });
  assert.equal(plugin.context.errCount, 0);
  assert.equal(plugin.context.writeCount, 0);
  assert.equal(plugin.metrics.responses.length, 0);
});

test("a genuine failed operation is counted and returned exactly once", async () => {
  const request = { id: "write-request", operation: "modify", params: {} };
  const plugin = createPlugin([{ delay: 0, body: { requests: [request] } }]);
  await plugin.advance(0);
  const message = { data: { pluginMessage: { id: request.id, operation: "modify", success: false, error: "Invalid target" } } };
  await plugin.context.window.onmessage(message);
  await plugin.context.window.onmessage(message);
  assert.equal(plugin.context.errCount, 1);
  assert.equal(plugin.metrics.responses.length, 1);
  assert.equal(plugin.metrics.responses[0].body.success, false);
});
