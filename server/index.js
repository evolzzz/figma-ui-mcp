#!/usr/bin/env node
// figma-ui-mcp — MCP server entry point
// Bidirectional Figma bridge: write UI from Claude, read design back to code.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import http from "node:http";

import { BridgeServer, CONFIG } from "./bridge-server.js";
import { executeCode } from "./code-executor.js";
import { TOOLS } from "./tool-definitions.js";
import { getDocs } from "./api-docs.js";

// ── Bridge connection strategy ─────────────────────────────────────────────
// Try to start own bridge server. If port is already taken (another instance
// or standalone bridge running), connect to the existing one via HTTP client.

let bridge;
let useHttpProxy = false;
let connectionAttempt = null;
let shuttingDown = false;

// HTTP proxy: forwards operations to existing bridge via /exec endpoint
const httpProxy = {
  port: CONFIG.PORT,
  isPluginConnected() { return true; }, // delegate health check to actual call
  get queueLength()  { return 0; },
  get lastPollAt()   { return Date.now(); },
  async sendOperation(operation, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ operation, params });
      const req = http.request({
        hostname: "127.0.0.1", port: CONFIG.PORT,
        path: "/exec" + (sessionId ? "?sessionId=" + encodeURIComponent(sessionId) : ""), method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      }, res => {
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.success) resolve(parsed.data);
            else reject(new Error(parsed.error || "Bridge error"));
          } catch { reject(new Error("Invalid bridge response")); }
        });
      });
      req.on("error", e => reject(new Error(`Bridge connection failed: ${e.message}`)));
      req.setTimeout(CONFIG.OP_TIMEOUT_MS, () => { req.destroy(); reject(new Error("Bridge timeout")); });
      req.end(payload);
    });
  },
  // Health check via HTTP
  async checkHealth() {
    return new Promise((resolve) => {
      const req = http.request({
        hostname: "127.0.0.1", port: CONFIG.PORT,
        path: "/health", method: "GET",
      }, res => {
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => {
          try {
            const health = JSON.parse(data);
            resolve(res.statusCode === 200 && health && typeof health.pluginConnected === "boolean" ? health : {});
          } catch { resolve({}); }
        });
        res.on("error", () => resolve({}));
      });
      // No bridge and a live bridge waiting for its plugin are different states.
      req.on("error", () => resolve({}));
      req.setTimeout(2000, () => { req.destroy(); resolve({}); });
      req.end();
    });
  },
};

// Startup and proxy failover share one ownership decision. Concurrent tool calls
// must not create multiple listeners or switch our own listener into proxy mode.
async function connectBridge() {
  if (connectionAttempt) return connectionAttempt;
  if (shuttingDown) throw new Error("Bridge is shutting down");
  if (bridge && !useHttpProxy) return;
  connectionAttempt = establishBridge();
  try {
    await connectionAttempt;
  } finally {
    connectionAttempt = null;
    if (shuttingDown && bridge && !useHttpProxy) bridge.stop();
  }
}

async function establishBridge() {
  // Reuse a responsive bridge even while its plugin is disconnected. Plugin
  // presence is session health, not permission to start another bridge process.
  const existingHealth = await httpProxy.checkHealth();
  if (typeof existingHealth.pluginConnected === "boolean") {
    useHttpProxy = true;
    bridge = httpProxy;
    process.stderr.write("[figma-ui-mcp] Existing bridge detected, using HTTP proxy\n");
  } else {
    // No healthy primary bridge — try to start our own
    try {
      bridge = await new BridgeServer().start();
      useHttpProxy = false;
      process.stderr.write("[figma-ui-mcp] Bridge started on port " + bridge.port + "\n");
    } catch (e) {
      // Another process may have acquired the port after our initial probe. Only
      // proxy to a verified bridge; unrelated services and bind failures stay errors.
      const primaryHealth = await httpProxy.checkHealth();
      if (typeof primaryHealth.pluginConnected !== "boolean") throw e;
      useHttpProxy = true;
      bridge = httpProxy;
      process.stderr.write("[figma-ui-mcp] Bridge failed, connecting to existing bridge on port " + CONFIG.PORT + "\n");
    }

    // A concurrent startup can win the primary port while we bind a fallback.
    // Release our redundant listener once the primary is confirmed as a bridge.
    if (!useHttpProxy && bridge.port !== CONFIG.PORT) {
      const primaryHealth = await httpProxy.checkHealth();
      if (typeof primaryHealth.pluginConnected === "boolean") {
        // A figma-ui-mcp bridge already owns the primary port — we are a redundant session.
        // Stop only the listener owned by this process and reuse the primary.
        bridge.stop();
        useHttpProxy = true;
        bridge = httpProxy;
        process.stderr.write("[figma-ui-mcp] Primary bridge exists on port " + CONFIG.PORT + ", switching to HTTP proxy\n");
      }
    }
  }
}

await connectBridge();

const server = new Server(
  { name: "figma-ui-mcp", version: "2.5.13" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args } }) => {
  let proxyHealth = {};
  if (["figma_status", "figma_write", "figma_read", "figma_rules"].includes(name) && useHttpProxy) {
    proxyHealth = await httpProxy.checkHealth();
    if (typeof proxyHealth.pluginConnected !== "boolean") {
      // Recover ownership before accepting a new command if the previous MCP
      // owner exited. Never replay an operation whose result is already unknown.
      try { await connectBridge(); }
      catch (error) { return err("Bridge connection failed: " + error.message); }
      if (useHttpProxy) proxyHealth = await httpProxy.checkHealth();
    }
  }

  // ── figma_status ──────────────────────────────────────────────────────────
  if (name === "figma_status") {
    let connected, pluginInfo = null, healthData = {};

    if (useHttpProxy) {
      healthData = proxyHealth;
      connected = Boolean(healthData.pluginConnected);
      if (connected) {
        try { pluginInfo = await bridge.sendOperation("status", {}); } catch { /* brief disconnect */ }
      }
    } else {
      connected = bridge.isPluginConnected();
      if (connected) {
        try { pluginInfo = await bridge.sendOperation("status", {}); } catch { /* brief disconnect */ }
      }
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          bridgePort:      bridge.port || CONFIG.PORT,
          pluginConnected: connected,
          pluginInfo,
          mode:            useHttpProxy ? "http-proxy" : "direct",
          queueLength:     healthData.queueLength || bridge.queueLength,
          lastPollAgoMs:   healthData.lastPollAgoMs || (bridge.lastPollAt ? Date.now() - bridge.lastPollAt : null),
          stats:           healthData.stats || (bridge.stats ? bridge.stats : null),
          sessions:        bridge.getSessions ? bridge.getSessions() : [],
          hint: connected
            ? "CONNECTED. BEFORE drawing anything: call figma_docs to load mandatory design rules (token system, component-first, icon sizing, layer order). Skipping figma_docs causes incorrect, hardcoded, low-quality UI."
            : "Plugin not connected. In Figma Desktop: Plugins → Development → Figma UI MCP Bridge → Run",
        }, null, 2),
      }],
    };
  }

  // ── figma_write ───────────────────────────────────────────────────────────
  if (name === "figma_write") {
    if (useHttpProxy) {
      if (!proxyHealth.pluginConnected) return notConnected();
    } else if (!bridge.isPluginConnected()) return notConnected();

    const code = args?.code;
    const writeSessionId = args?.sessionId;
    if (!code || typeof code !== "string") return err("'code' is required.");

    const { success, result, error, logs } = await executeCode(code, bridge, writeSessionId);
    const parts = [];
    if (logs.length) parts.push(`Logs:\n${logs.join("\n")}`);
    parts.push(success ? `Result: ${JSON.stringify(result, null, 2)}` : `Error: ${error}`);

    return { isError: !success, content: [{ type: "text", text: parts.join("\n\n") }] };
  }

  // ── figma_read ────────────────────────────────────────────────────────────
  if (name === "figma_read") {
    if (useHttpProxy) {
      if (!proxyHealth.pluginConnected) return notConnected();
    } else if (!bridge.isPluginConnected()) return notConnected();

    const { operation, nodeId, nodeName, scale, depth, format, detail, includeHidden, sessionId: readSessionId, ...searchParams } = args || {};
    if (!operation) return err("'operation' is required.");

    const params = {};
    if (nodeId)   params.id    = nodeId;
    if (nodeName) params.name  = nodeName;
    if (scale)    params.scale = scale;
    if (depth !== undefined) params.depth = depth;
    if (format) params.format = format;
    if (detail) params.detail = detail;
    if (includeHidden !== undefined) params.includeHidden = includeHidden;
    if (operation === "search_nodes") Object.assign(params, searchParams);

    try {
      const data = await bridge.sendOperation(operation, params, readSessionId);

      // Return screenshot as MCP image content (displays inline in Claude Code)
      if (operation === "screenshot" && data && data.dataUrl) {
        var b64 = data.dataUrl;
        if (b64.indexOf(",") !== -1) b64 = b64.split(",")[1];
        var meta = Object.assign({}, data);
        delete meta.dataUrl;
        var content = [{ type: "image", data: b64, mimeType: "image/png" }];
        if (Object.keys(meta).length > 0) {
          content.push({ type: "text", text: JSON.stringify(meta, null, 2) });
        }
        return { content: content };
      }

      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return err(e.message);
    }
  }

  // ── figma_docs ────────────────────────────────────────────────────────────
  if (name === "figma_docs") {
    return { content: [{ type: "text", text: getDocs(args?.section) }] };
  }

  // ── figma_rules ───────────────────────────────────────────────────────────
  // Aggregate design system rules from styles + variables + components into a
  // prompt-injectable markdown block. Equivalent to official MCP's create_design_system_rules.
  if (name === "figma_rules") {
    if (useHttpProxy) {
      if (!proxyHealth.pluginConnected) return notConnected();
    } else if (!bridge.isPluginConnected()) return notConnected();

    const sessionId = args?.sessionId;
    try {
      const [stylesData, varsData, compsData] = await Promise.all([
        bridge.sendOperation("get_styles", {}, sessionId),
        bridge.sendOperation("get_variables", {}, sessionId),
        bridge.sendOperation("get_local_components", {}, sessionId),
      ]);

      const lines = ["# Design System Rules", ""];
      lines.push("Use these tokens, styles, and components when writing code for this Figma file.", "");

      // Colors
      if (stylesData.paintStyles && stylesData.paintStyles.length) {
        lines.push("## Color Tokens (Paint Styles)");
        lines.push("```");
        stylesData.paintStyles.forEach(s => {
          if (s.hex) lines.push(`--${s.name.replace(/\//g, "-")}: ${s.hex};  /* ${s.name} */`);
        });
        lines.push("```", "");
      }

      // Variables by collection
      if (varsData.collections && varsData.collections.length) {
        varsData.collections.forEach(col => {
          if (!col.variables || !col.variables.length) return;
          lines.push(`## Variables — ${col.name}`);
          const modes = col.modes.map(m => m.name);
          if (modes.length > 1) lines.push(`Modes: ${modes.join(" | ")}`);
          lines.push("```");
          col.variables.forEach(v => {
            const vals = Object.values(v.valuesByMode || {});
            const preview = vals.length > 0 ? String(vals[0]) : "";
            lines.push(`${v.name} (${v.resolvedType})${preview ? ": " + preview : ""}`);
          });
          lines.push("```", "");
        });
      }

      // Typography
      if (stylesData.textStyles && stylesData.textStyles.length) {
        lines.push("## Typography Styles");
        lines.push("```");
        stylesData.textStyles.forEach(s => {
          lines.push(`${s.name}: ${s.fontFamily} ${s.fontWeight} ${s.fontSize}px${s.lineHeight ? " / " + s.lineHeight + "px" : ""}`);
        });
        lines.push("```", "");
      }

      // Components
      if (compsData.componentSets && compsData.componentSets.length) {
        lines.push("## Component Sets (use with get_component_map)");
        compsData.componentSets.forEach(s => {
          const desc = s.description ? ` — ${s.description}` : "";
          lines.push(`- **${s.name}** (${s.variantCount} variants)${desc}`);
        });
        lines.push("");
      }
      if (compsData.components && compsData.components.length) {
        lines.push("## Standalone Components");
        compsData.components.slice(0, 40).forEach(c => {
          const desc = c.description ? ` — ${c.description}` : "";
          lines.push(`- **${c.name}** (${c.width}×${c.height})${desc}`);
        });
        if (compsData.components.length > 40) lines.push(`  …and ${compsData.components.length - 40} more`);
        lines.push("");
      }

      lines.push("---");
      lines.push("_Generated by figma-ui-mcp figma_rules. Re-run when design system changes._");

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) {
      return err("figma_rules failed: " + e.message);
    }
  }

  return err(`Unknown tool: ${name}`);
});

function notConnected() {
  return {
    isError: true,
    content: [{
      type: "text",
      text: "Figma plugin not connected. Run the 'Figma UI MCP Bridge' plugin in Figma Desktop first.",
    }],
  };
}

function err(msg) {
  return { isError: true, content: [{ type: "text", text: msg }] };
}

// The stdio transport does not close the HTTP listener when stdin reaches EOF.
// Release our own bridge at session end instead of leaving orphan processes for
// later sessions to discover. A proxy session must never stop the shared owner.
server.onclose = () => {
  shuttingDown = true;
  if (!useHttpProxy) bridge.stop();
};
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!useHttpProxy) bridge.stop();
  server.close().catch(error => {
    process.stderr.write("[figma-ui-mcp] Shutdown failed: " + error.message + "\n");
    process.exitCode = 1;
  });
}
process.stdin.once("end", shutdown);
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
await server.connect(new StdioServerTransport());
