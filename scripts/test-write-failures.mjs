import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../plugin/code.js", import.meta.url), "utf8");
const mixed = Symbol("mixed");

function plugin(nodes = []) {
  const messages = [], fonts = [];
  const page = { id: "page", type: "PAGE", name: "Page", selection: [], findOne: predicate => nodes.find(predicate), appendChild(node) { node.parent = this; } };
  const figma = {
    mixed, currentPage: page,
    root: { id: "root", name: "Document", children: [page], findOne: predicate => nodes.find(predicate) },
    async getNodeByIdAsync(id) { return nodes.find(node => node.id === id); },
    async loadFontAsync(font) { assert.equal(typeof font.family, "string"); fonts.push(font); },
    async loadAllPagesAsync() {}, showUI() {},
    ui: { postMessage(message) { messages.push(message); } },
  };
  const context = vm.createContext({ figma, __html__: "", console });
  vm.runInContext(source, context);
  return { handlers: vm.runInContext("handlers", context), figma, fonts, messages, page };
}

function variantFixture() {
  const definitions = { "label#1": { type: "TEXT", defaultValue: "Label" }, "visible#2": { type: "BOOLEAN", defaultValue: true }, State: { type: "VARIANT", defaultValue: "Default" } };
  const owner = {
    id: "set", type: "COMPONENT_SET", name: "Control", componentPropertyDefinitions: definitions,
    addComponentProperty(name, type, value) { const key = name + "#new"; definitions[key] = { type, defaultValue: value }; return key; },
    deleteComponentProperty(key) { delete definitions[key]; },
  };
  const variant = { id: "variant", type: "COMPONENT", name: "State=Default", parent: owner };
  // Match the real API instead of treating a variant like a standalone master.
  Object.defineProperty(variant, "componentPropertyDefinitions", { get() { throw new Error("Cannot read definitions on a variant"); } });
  variant.addComponentProperty = variant.deleteComponentProperty = () => { throw new Error("Cannot modify definitions on a variant"); };
  const text = { id: "text", type: "TEXT", name: "Label", parent: variant, componentPropertyReferences: {} };
  const instance = { id: "instance", type: "INSTANCE", name: "Control instance", componentProperties: {}, async getMainComponentAsync() { return variant; }, setProperties(values) { this.componentProperties = values; } };
  return { owner, variant, text, instance, ...plugin([owner, variant, text, instance]) };
}

test("component property create, bind, update, and delete resolve the variant's set", async () => {
  const p = variantFixture();
  assert.equal((await p.handlers.addComponentProperty({ componentId: "variant", name: "caption", type: "TEXT", defaultValue: "Caption" })).componentId, "set");
  assert.equal((await p.handlers.bindComponentPropertyToText({ textNodeId: "text", propertyName: "caption" })).componentId, "set");
  assert.equal(p.text.componentPropertyReferences.characters, "caption#new");
  await p.handlers.bindComponentProperty({ nodeId: "text", field: "visible", propertyName: "visible" });
  assert.equal(p.text.componentPropertyReferences.visible, "visible#2");
  await p.handlers.setComponentProperties({ id: "instance", properties: { label: "Updated", State: "Active" } });
  assert.equal(p.instance.componentProperties["label#1"], "Updated");
  assert.equal(p.instance.componentProperties.State, "Active");
  assert.equal((await p.handlers.removeComponentProperty({ componentId: "variant", propertyName: "caption" })).removedProperty, "caption#new");
});

test("ambiguous property labels require full IDs instead of modifying the first match", async () => {
  const p = variantFixture();
  p.owner.componentPropertyDefinitions["label#other"] = { type: "TEXT", defaultValue: "Other" };
  await assert.rejects(p.handlers.setComponentProperties({ id: "instance", properties: { label: "Wrong" } }), /Ambiguous/);
  await assert.rejects(p.handlers.removeComponentProperty({ componentId: "variant", propertyName: "label" }), /Ambiguous/);
  assert.ok(p.owner.componentPropertyDefinitions["label#1"]);
  await p.handlers.setComponentProperties({ id: "instance", properties: { "label#other": "Right" } });
  assert.equal(p.instance.componentProperties["label#other"], "Right");
});

test("variant dimensions cannot be removed using the ordinary property API", async () => {
  const p = variantFixture();
  await assert.rejects(p.handlers.removeComponentProperty({ componentId: "variant", propertyName: "State" }), error => {
    assert.match(error.message, /VARIANT property "State"/);
    assert.match(error.message, /with removeComponentProperty/);
    assert.match(error.message, /deleteComponentProperty supports BOOLEAN, TEXT, INSTANCE_SWAP, and SLOT/);
    return true;
  });
  assert.ok(p.owner.componentPropertyDefinitions.State);
});

for (const change of [{ fontSize: 20 }, { width: 240, textAutoResize: "NONE" }, { lineHeight: 28 }]) {
  test(`text layout loads its font before mutation: ${Object.keys(change).join(", ")}`, async () => {
    const font = { family: "Example Sans", style: "Regular" };
    const text = { id: "text", type: "TEXT", name: "Label", fontName: font, characters: "Label", height: 20 };
    const p = plugin([text]);
    let resizeMode = "HEIGHT", fontSize = 14, lineHeight = {};
    function loaded() { assert.ok(p.fonts.some(item => item.family === font.family)); }
    Object.defineProperties(text, {
      textAutoResize: { get: () => resizeMode, set(value) { loaded(); resizeMode = value; } },
      fontSize: { get: () => fontSize, set(value) { loaded(); fontSize = value; } },
      lineHeight: { get: () => lineHeight, set(value) { loaded(); lineHeight = value; } },
    });
    text.resize = function(width, height) { loaded(); this.width = width; this.height = height; };
    await p.handlers.modify({ id: "text", ...change });
    assert.equal(p.fonts.length, 1);
  });
}

test("content-only updates load all mixed fonts and preserve their runs", async () => {
  const first = { family: "Example Sans", style: "Regular" }, second = { family: "Example Serif", style: "Bold" };
  const text = { id: "text", type: "TEXT", name: "Mixed", fontName: mixed, characters: "Mixed", textAutoResize: "NONE", getRangeAllFontNames: () => [first, second, first] };
  const p = plugin([text]);
  await p.handlers.modify({ id: "text", content: "Changed" });
  assert.equal(p.fonts.length, 2);
  assert.equal(text.fontName, mixed);
  assert.equal(text.characters, "Changed");
});

test("a font load failure leaves earlier non-text fields and geometry unchanged", async () => {
  const text = { id: "text", type: "TEXT", name: "Original", fontName: { family: "Missing", style: "Regular" }, width: 100, resize() { throw new Error("Must not resize"); } };
  const p = plugin([text]);
  p.figma.loadFontAsync = async () => { throw new Error("Font unavailable"); };
  await assert.rejects(p.handlers.modify({ id: "text", name: "Changed", width: 200, textAutoResize: "NONE" }), /Font unavailable/);
  assert.equal(text.name, "Original");
  assert.equal(text.width, 100);
});

test("mixed font sizes read through design tokens and CSS without Symbol conversion errors", async () => {
  const text = { id: "text", type: "TEXT", name: "Mixed sizes", characters: "SmallLarge", x: 0, y: 0, width: 200, height: 40,
    fontName: { family: "Example Sans", style: "Regular" }, fontSize: mixed, lineHeight: mixed, letterSpacing: mixed,
    getStyledTextSegments: () => [
      { characters: "Small", fontName: { family: "Example Sans", style: "Regular" }, fontSize: 14, fills: [] },
      { characters: "Large", fontName: { family: "Example Sans", style: "Regular" }, fontSize: 20, fills: [] },
    ],
  };
  const p = plugin([text]);
  p.page.selection = [text];
  const result = await p.handlers.get_design({ id: "text" });
  assert.equal(result.tree.fontSize, "mixed");
  assert.equal(result.tree.mixedStyles, true);
  assert.deepEqual(Array.from(result.tokens.fonts).sort(), ["Example Sans/Regular/14px", "Example Sans/Regular/20px"]);
  assert.equal((await p.handlers.get_selection({})).tokens.fonts.length, 2);
  const css = await p.handlers.get_css({ id: "text" });
  assert.doesNotMatch(css.css, /mixed|Symbol|font-size:/);
});

test("scroll behavior implements native directions and the documented BOTH alias", async () => {
  const node = { id: "frame", type: "FRAME", overflowDirection: "NONE", clipsContent: true };
  const p = plugin([node]);
  await p.handlers.setScrollBehavior({ id: "frame", overflowDirection: "BOTH", clipsContent: false });
  assert.equal(node.overflowDirection, "HORIZONTAL_AND_VERTICAL");
  assert.equal(node.clipsContent, false);
  await assert.rejects(p.handlers.setScrollBehavior({ id: "frame", overflowDirection: "VERTICAL", clipsContent: "yes" }), /boolean/);
  assert.equal(node.overflowDirection, "HORIZONTAL_AND_VERTICAL");
});

test("invalid instance parents are rejected before creating nodes", async () => {
  let creations = 0;
  const instance = { id: "instance", type: "INSTANCE", appendChild() {} };
  const nested = { id: "nested", type: "FRAME", parent: instance, appendChild() {} };
  const master = { id: "master", type: "COMPONENT", createInstance() { creations++; throw new Error("Must not create"); } };
  const p = plugin([instance, nested, master]);
  for (const parentId of ["instance", "nested"]) {
    await assert.rejects(p.handlers.instantiate({ componentId: "master", parentId }), /inside an instance/);
    await assert.rejects(p.handlers.create({ type: "FRAME", parentId }), /inside an instance/);
  }
  await assert.rejects(p.handlers.instantiate({ componentId: "master", parentId: "missing" }), /parent not found/);
  assert.equal(creations, 0);
});

test("a failed new instance is cleaned up without modifying its master", async () => {
  let removed = false;
  const parent = { id: "parent", type: "FRAME", appendChild() { throw new Error("Parent changed"); } };
  const master = { id: "master", type: "COMPONENT", createInstance: () => ({ remove() { removed = true; } }) };
  const p = plugin([parent, master]);
  await assert.rejects(p.handlers.instantiate({ componentId: "master", parentId: "parent" }), /Parent changed/);
  assert.equal(removed, true);
});

test("instance descendant position errors are reported before unrelated mutations", async () => {
  const parent = { id: "instance", type: "INSTANCE" };
  const child = { id: "child", type: "FRAME", name: "Original", parent, x: 10 };
  const p = plugin([child]);
  await assert.rejects(p.handlers.modify({ id: "child", x: 20, name: "Changed" }), /relative position inside an instance/);
  assert.equal(child.name, "Original");
  assert.equal(child.x, 10);
});
