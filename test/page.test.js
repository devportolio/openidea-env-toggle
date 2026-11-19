// The real page in jsdom: web/envfile.js and web/app.js as packaged, over the
// dev bridge (dev/mock-bridge.js), driven through its own controls. What it
// writes is read back by independent readers: `dotenv` and Node's parseEnv.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseEnv } = require("node:util");
const dotenv = require("dotenv");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..");
const source = (p) => fs.readFileSync(path.join(root, p), "utf8");

function loaded(text, key) {
  return { dotenv: dotenv.parse(text)[key], node: parseEnv(text)[key] };
}
const both = (v) => ({ dotenv: v, node: v });

/** Opens the page on `text`; returns its window, document and the fake IDE document. */
function openPage(text) {
  const html = source("web/index.html").replace(/<script[\s\S]*?<\/script>/g, "");
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.Element.prototype.scrollIntoView = function () {}; // not in jsdom
  w.eval(source("dev/mock-bridge.js"));
  const ide = w.MockBridge.install({ text, name: ".env" });
  w.eval(source("web/envfile.js"));
  w.eval(source("web/app.js"));
  return { w, doc: w.document, ide };
}

/** Lets the page's queued edits and renders finish. */
const settle = () => new Promise((r) => setTimeout(r, 30));

function typeInto(w, el, value) {
  el.value = value;
  el.dispatchEvent(new w.Event("input", { bubbles: true }));
}

function press(w, el, key, mods = {}) {
  el.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }));
}

/** Fills + Add's form and presses its Add button. */
async function addThroughForm(page, key, value) {
  const { w, doc } = page;
  doc.querySelector(".bar .add").click();
  typeInto(w, doc.querySelector(".key-in"), key);
  typeInto(w, doc.querySelector(".val-in"), value);
  doc.querySelector(".adder .primary").click();
  await settle();
}

/** Clicks a row's value, replaces the text in the editor, and saves with Enter (⌘Enter in a text box). */
async function editThroughRow(page, line, change) {
  const { w, doc } = page;
  doc.querySelector('button.val[data-line="' + line + '"]').click();
  const ed = doc.querySelector(".val-edit");
  assert.ok(ed, "the editor opened");
  typeInto(w, ed, change(ed.value));
  press(w, ed, "Enter", { metaKey: ed.tagName === "TEXTAREA" });
  await settle();
  return ed;
}

const VALUES = [
  '{"name":"O\'Reilly"}', // the review's case
  "C:\\temp\\", // the review's case
  "two words",
  "a #b",
  " lead",
  "it's",
  'say "hi"',
  '{"name": "O\'Reilly #1"}',
  "\\n stays a backslash and n",
];

test("page: + Add writes each value so both readers load it unchanged", async () => {
  for (const v of VALUES) {
    const page = await openPage("# App\nA=1\n");
    await settle();
    await addThroughForm(page, "CONFIG", v);
    assert.deepEqual(loaded(page.ide.text, "CONFIG"), both(v), JSON.stringify({ v, text: page.ide.text }));
    assert.equal(page.doc.querySelector(".adder").hidden, true, "the form closed");
  }
});

test("page: editing a value with \\n escapes keeps what readers load (the review's case)", async () => {
  const page = openPage('CONFIG="line1\\nline2"\n');
  await settle();
  const ed = await editThroughRow(page, 0, (v) => v + "!");
  assert.equal(ed.tagName, "TEXTAREA", "a value with a line break opens in a text box");
  assert.equal(page.ide.text, 'CONFIG="line1\\nline2!"\n');
  assert.deepEqual(loaded(page.ide.text, "CONFIG"), both("line1\nline2!"));
});

test("page: editing other kinds of lines keeps what readers load", async () => {
  const cases = [
    ["P='C:\\temp\\'\n", (v) => v + "x", "C:\\temp\\x"],
    ["J=x\n", () => '{"name":"O\'Reilly"}', '{"name":"O\'Reilly"}'],
    ["Q='single'\n", () => "it's", "it's"],
    ["E=abc # note\n", (v) => v + " def", "abc def"],
  ];
  for (const [text, change, want] of cases) {
    const page = openPage(text);
    await settle();
    await editThroughRow(page, 0, change);
    const key = text.split("=")[0];
    assert.deepEqual(loaded(page.ide.text, key), both(want), JSON.stringify({ text, after: page.ide.text }));
  }
});

test("page: a value no quoting can hold is refused visibly, and nothing is written", async () => {
  const bad = "all ' \" ` #";

  // + Add: the form stays open with the reason, the file is untouched.
  const page = openPage("A=1\n");
  await settle();
  await addThroughForm(page, "CONFIG", bad);
  assert.equal(page.ide.text, "A=1\n");
  assert.equal(page.doc.querySelector(".adder").hidden, false);
  const hint = page.doc.querySelector(".adder .hint");
  assert.ok(hint.classList.contains("error") && /can't be written/.test(hint.textContent), hint.textContent);
  assert.ok(page.doc.querySelector(".val-in").classList.contains("invalid"));

  // Edit, Enter: the editor stays open and marked; the banner says why.
  const edit = openPage("K=x\n");
  await settle();
  await editThroughRow(edit, 0, () => bad);
  assert.equal(edit.ide.text, "K=x\n");
  const ed = edit.doc.querySelector(".val-edit");
  assert.ok(ed && ed.classList.contains("invalid"), "the editor stays open, marked");
  const banner = edit.doc.querySelector(".banner");
  assert.ok(!banner.hidden && /can't be written/.test(banner.textContent), banner.textContent);
});
