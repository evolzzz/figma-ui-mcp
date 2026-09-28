import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { executeCode } from "../server/code-executor.js";

// Exercise the distributed bundle, so omitted source modules fail the same way
// as they would after importing plugin.zip into Figma.
const source = readFileSync(new URL("../plugin/code.js", import.meta.url), "utf8");

function loadPlugin(nodes = []) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const messages = [];
  const figma = {
    root: { id: "root", name: "Test document", children: [] },
    currentPage: { id: "page", name: "Test", selection: [], findOne: predicate => nodes.find(predicate) },
    getNodeByIdAsync: async id => byId.get(id),
    loadFontAsync: async () => {},
    loadAllPagesAsync: async () => {},
    showUI() {},
    ui: { postMessage: message => messages.push(message) },
  };
  const context = vm.createContext({ figma, __html__: "", console });
  vm.runInContext(source, context);
  return { figma, context, messages, handlers: vm.runInContext("handlers", context) };
}

for (const type of ["FRAME", "COMPONENT", "INSTANCE"]) {
  test(`modify updates auto-layout on ${type}`, async () => {
    const node = { id: type, type, name: type, layoutMode: "NONE", description: "" };
    const { handlers } = loadPlugin([node]);
    await handlers.modify({ id: node.id, layoutMode: "HORIZONTAL", padding: 16, itemSpacing: 8, primaryAxisSizingMode: "AUTO", description: "Responsive" });
    assert.equal(node.layoutMode, "HORIZONTAL");
    assert.equal(node.paddingLeft, 16);
    assert.equal(node.paddingBottom, 16);
    assert.equal(node.itemSpacing, 8);
    assert.equal(node.primaryAxisSizingMode, "AUTO");
    assert.equal(node.description, "Responsive");
    await handlers.modify({ id: node.id, layoutMode: "NONE" });
    assert.equal(node.layoutMode, "NONE");
  });
}

test("explicit text and geometry overrides work without content or color updates", async () => {
  const node = { id: "text", type: "TEXT", textAutoResize: "WIDTH_AND_HEIGHT", constraints: {}, layoutPositioning: "AUTO", strokeWeight: 1 };
  const { handlers } = loadPlugin([node]);
  await handlers.modify({ id: node.id, textAutoResize: "HEIGHT", constraints: { horizontal: "STRETCH", vertical: "MIN" }, layoutPositioning: "ABSOLUTE", strokeWeight: 0 });
  assert.equal(node.textAutoResize, "HEIGHT");
  assert.equal(node.constraints.horizontal, "STRETCH");
  assert.equal(node.layoutPositioning, "ABSOLUTE");
  assert.equal(node.strokeWeight, 0);
  const unsupported = { id: "shape", type: "RECTANGLE" };
  const other = loadPlugin([unsupported]);
  await other.handlers.modify({ id: unsupported.id, textAutoResize: "HEIGHT", constraints: {}, layoutPositioning: "ABSOLUTE", description: "ignored" });
  assert.equal("textAutoResize" in unsupported, false);
  assert.equal("constraints" in unsupported, false);
  assert.equal("layoutPositioning" in unsupported, false);
  assert.equal("description" in unsupported, false);
});

test("prototype operations run through the executor and preserve native actions", async () => {
  const node = { id: "button", type: "FRAME", reactions: [], async setReactionsAsync(reactions) { this.reactions = reactions; } };
  const { handlers } = loadPlugin([node]);
  const bridge = { sendOperation: (operation, params) => handlers[operation](params) };
  await executeCode(`await figma.setReactions({ id: "button", reactions: [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "NAVIGATE", destinationId: "screen" }, { type: "BACK" }] }] });`, bridge);
  assert.equal(node.reactions[0].actions[0].type, "NODE");
  assert.equal(node.reactions[0].actions[0].navigation, "NAVIGATE");
  assert.equal(node.reactions[0].actions[0].destinationId, "screen");
  assert.equal(node.reactions[0].actions[1].type, "BACK");
  assert.equal((await handlers.getReactions({ id: node.id })).reactions, node.reactions);
  await executeCode(`await figma.removeReactions({ id: "button" });`, bridge);
  assert.equal(node.reactions.length, 0);
  await assert.rejects(handlers.setReactions({ id: node.id, reactions: null }), /must be an array/);
  await assert.rejects(handlers.getReactions({ id: "missing" }), /does not support/);
});

test("prototype updates preserve native reactions and reject malformed data before writing", async () => {
  let writes = 0;
  const node = { id: "node", reactions: [], async setReactionsAsync(reactions) { writes++; this.reactions = reactions; } };
  const { handlers } = loadPlugin([node]);
  const native = { trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", navigation: "OVERLAY", destinationId: "overlay" }] };
  const legacy = { trigger: { type: "ON_HOVER" }, action: { type: "URL", url: "https://example.com" } };
  await handlers.setReactions({ id: node.id, reactions: [native, legacy] });
  assert.equal(node.reactions[0].actions[0], native.actions[0]);
  assert.equal(node.reactions[1].action, legacy.action);
  assert.equal("actions" in node.reactions[1], false);
  assert.equal("navigation" in native.actions[0], true);
  for (const reactions of [[null], [{ actions: {} }], [{ actions: [null] }]]) {
    await assert.rejects(handlers.setReactions({ id: node.id, reactions }));
  }
  assert.equal(writes, 1);
});

test("dispatcher returns prototype errors without changing the existing reactions", async () => {
  const node = { id: "button", reactions: [{ old: true }], async setReactionsAsync() { throw new Error("Invalid destination"); } };
  const { figma, messages } = loadPlugin([node]);
  await figma.ui.onmessage({ id: "request", operation: "setReactions", params: { id: node.id, reactions: [] } });
  assert.equal(messages[0].success, false);
  assert.match(messages[0].error, /Invalid destination/);
  assert.equal(node.reactions[0].old, true);
});

test("plugin status uses the package version supplied by the build", async () => {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal((await loadPlugin().handlers.status()).version, version);
});
