import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { BridgeServer, CONFIG } from "../server/bridge-server.js";

const entry = fileURLToPath(new URL("../server/index.js", import.meta.url));

async function listen(server, port = 0) {
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

function configure(t, overrides = {}) {
  const previous = { ...CONFIG };
  Object.assign(CONFIG, { PORT: 0, PORT_RANGE: 1, HOST: "127.0.0.1" }, overrides);
  t.after(() => Object.assign(CONFIG, previous));
}

function request(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port, path, agent: false }, res => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(2000, () => req.destroy(new Error("Test request timed out")));
  });
}

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for bridge state");
    await delay(10);
  }
}

async function freePort() {
  const reservation = http.createServer();
  const port = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  return port;
}

function startMcp(t, port) {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, FIGMA_MCP_PORT: String(port) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = [];
  let stderr = "", stdout = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    stdout += chunk;
    let end;
    while ((end = stdout.indexOf("\n")) !== -1) {
      messages.push(JSON.parse(stdout.slice(0, end)));
      stdout = stdout.slice(end + 1);
    }
  });
  const exited = once(child, "exit");
  t.after(async () => {
    // Only terminate this test's child if a regression prevents normal EOF exit.
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  child.stdin.on("error", () => {});
  function send(message) { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
  async function ready() {
    send({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "lifecycle-test", version: "1.0.0" } } });
    await waitFor(() => messages.some(message => message.id === 1) || child.exitCode !== null);
    assert.equal(child.exitCode, null, stderr);
    assert.ok(messages.find(message => message.id === 1)?.result, stderr);
    send({ method: "notifications/initialized" });
  }
  let requestId = 1;
  async function callTool(name, args = {}) {
    const id = ++requestId;
    send({ id, method: "tools/call", params: { name, arguments: args } });
    await waitFor(() => messages.some(message => message.id === id));
    return messages.find(message => message.id === id).result;
  }
  async function status() {
    return JSON.parse((await callTool("figma_status")).content[0].text);
  }
  async function end() {
    child.stdin.end();
    await waitFor(() => child.exitCode !== null || child.signalCode !== null);
    assert.equal((await exited)[0], 0, stderr);
  }
  return { child, ready, status, callTool, end, stderr: () => stderr };
}

test("occupied ports are preserved and exhaustion rejects startup", { timeout: 5000 }, async t => {
  const owner = http.createServer((req, res) => res.end("unrelated service"));
  const port = await listen(owner);
  t.after(() => new Promise(resolve => owner.close(resolve)));
  configure(t, { PORT: port });
  await assert.rejects(new BridgeServer().start(), { code: "EADDRINUSE" });
  assert.equal((await request(port, "/health")).body, "unrelated service");
});

test("a port conflict selects the next available port without evicting its owner", { timeout: 5000 }, async t => {
  const owner = http.createServer((req, res) => res.end("owner"));
  const port = await listen(owner);
  t.after(() => new Promise(resolve => owner.close(resolve)));
  configure(t, { PORT: port, PORT_RANGE: 10 });
  const bridge = await new BridgeServer().start();
  t.after(() => bridge.stop());
  assert.ok(bridge.port > port && bridge.port < port + 10);
  assert.equal(JSON.parse((await request(bridge.port, "/health")).body).pluginConnected, false);
  assert.equal((await request(port, "/health")).body, "owner");
});

test("invalid bind parameters reject instead of reporting ready", async t => {
  configure(t, { PORT: -1 });
  await assert.rejects(new BridgeServer().start(), { code: "ERR_SOCKET_BAD_PORT" });
});

test("shutdown drains held polls and rejects pending work immediately", { timeout: 5000 }, async t => {
  configure(t);
  const bridge = await new BridgeServer().start();
  t.after(() => bridge.stop());
  // Queue work in the default session before creating a separate idle poll.
  const rejected = assert.rejects(bridge.sendOperation("status", {}), /shutting down/);
  const poll = request(bridge.port, "/poll?sessionId=idle");
  await waitFor(() => bridge.getSessions().some(session => session.id === "idle"));
  bridge.stop();
  assert.equal((await poll).status, 503);
  await rejected;
  assert.equal(bridge.pendingCount, 0);
  assert.deepEqual(bridge.getSessions(), []);
});

test("operation timeout releases the global pending index as well as the queue", async t => {
  configure(t, { OP_TIMEOUT_MS: 20 });
  const bridge = await new BridgeServer().start();
  t.after(() => bridge.stop());
  await assert.rejects(bridge.sendOperation("status", {}), /timed out/);
  assert.equal(bridge.queueLength, 0);
  assert.equal(bridge.pendingCount, 0);
});

test("MCP stdin EOF releases a directly owned bridge", { timeout: 10000 }, async t => {
  const port = await freePort();
  const mcp = startMcp(t, port);
  await mcp.ready();
  const status = await mcp.status();
  assert.equal(status.mode, "direct");
  assert.equal(status.bridgePort, port);
  assert.equal(status.pluginConnected, false);
  await mcp.end();
  await assert.rejects(request(port, "/health"), { code: "ECONNREFUSED" });
});

test("MCP reuses a bridge with no plugin and EOF preserves the shared owner", { timeout: 10000 }, async t => {
  configure(t);
  const owner = await new BridgeServer().start();
  t.after(() => owner.stop());
  const mcp = startMcp(t, owner.port);
  await mcp.ready();
  assert.equal((await mcp.status()).mode, "http-proxy");
  assert.doesNotMatch(mcp.stderr(), /Port .* in use|Bridge started/);
  await mcp.end();
  assert.equal(JSON.parse((await request(owner.port, "/health")).body).pluginConnected, false);
});

test("malformed health responses are not mistaken for an idle bridge", { timeout: 10000 }, async t => {
  const owner = http.createServer((req, res) => res.end("not JSON"));
  const port = await listen(owner);
  t.after(() => new Promise(resolve => owner.close(resolve)));
  const mcp = startMcp(t, port);
  await mcp.ready();
  const status = await mcp.status();
  assert.equal(status.mode, "direct");
  assert.ok(status.bridgePort > port, JSON.stringify({ port, status, stderr: mcp.stderr() }));
  await mcp.end();
  assert.equal((await request(port, "/health")).body, "not JSON");
});

test("concurrent calls reacquire one bridge after the shared owner exits", { timeout: 10000 }, async t => {
  configure(t);
  const owner = await new BridgeServer().start();
  t.after(() => owner.stop());
  const mcp = startMcp(t, owner.port);
  await mcp.ready();
  assert.equal((await mcp.status()).mode, "http-proxy");
  owner.stop();
  await assert.rejects(request(owner.port, "/health"), { code: "ECONNREFUSED" });
  const statuses = await Promise.all([mcp.status(), mcp.status()]);
  for (const status of statuses) {
    assert.equal(status.mode, "direct");
    assert.equal(status.bridgePort, owner.port);
  }
  assert.equal((mcp.stderr().match(/Bridge started on port/g) || []).length, 1);
  await mcp.end();
});

test("HTTP proxy preserves the caller's explicit document session", { timeout: 10000 }, async t => {
  const owner = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/health") res.end(JSON.stringify({ pluginConnected: true }));
    else res.end(JSON.stringify({ success: true, data: { session: url.searchParams.get("sessionId") } }));
  });
  const port = await listen(owner);
  t.after(() => new Promise(resolve => owner.close(resolve)));
  const mcp = startMcp(t, port);
  await mcp.ready();
  const result = await mcp.callTool("figma_read", { operation: "get_design", sessionId: "document A" });
  assert.equal(JSON.parse(result.content[0].text).session, "document A");
  await mcp.end();
});
