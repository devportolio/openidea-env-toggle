// What the plugin writes, read back by independent .env readers: the `dotenv`
// package and Node's own `util.parseEnv` (the `--env-file` reader). The
// plugin's own parser is not the judge here.
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseEnv } = require("node:util");
const dotenv = require("dotenv");
const { parse, addVariable, setValue, toggle, applyEdits, canWrite } = require("../web/envfile.js");

/** What each reader loads for `key` from `text`. */
function loaded(text, key) {
  return { dotenv: dotenv.parse(text)[key], node: parseEnv(text)[key] };
}

const both = (v) => ({ dotenv: v, node: v });

// Values that are easy to get wrong: quotes, backslashes, #, spaces, line breaks.
const VALUES = [
  "",
  "plain",
  "two words",
  "a #b",
  "abc#def",
  " lead",
  "trail ",
  "\ttab",
  '{"name":"O\'Reilly"}',
  '{"name": "O\'Reilly #1"}',
  "C:\\temp\\",
  "C:\\new folder\\x",
  "\\n is not a line break",
  "line1\nline2",
  "it's",
  'say "hi"',
  "both ' and \"",
  "back`tick",
  '"quoted"',
  "'single'",
  "`tick`",
  "x=y&z=1",
  "postgres://u:p@h:5432/db?ssl=true",
  "multi\nline 'with' quotes",
  "ünïcödé ✓ 😀",
];

// Needs quotes and holds ', " and `: no way of writing keeps it.
const UNWRITABLE = ["all ' \" ` #", " ' \" ` ", "'\"`\n"];

test("+ Add: every writable value loads unchanged in dotenv and Node", () => {
  for (const v of VALUES) {
    assert.ok(canWrite(v), JSON.stringify(v));
    for (const start of ["", "A=1\n", "# Group\nA=1\n"]) {
      const { edits } = addVariable(parse(start), { key: "NEW", value: v, section: null });
      const text = applyEdits(start, edits);
      assert.deepEqual(loaded(text, "NEW"), both(v), JSON.stringify({ v, text }));
      assert.equal(loaded(text, "A").dotenv, start ? "1" : undefined, "neighbours stay");
    }
  }
});

test("+ Add: a value no quoting can hold is refused, not changed", () => {
  for (const v of UNWRITABLE) {
    assert.equal(canWrite(v), false, JSON.stringify(v));
    assert.throws(() => addVariable(parse(""), { key: "NEW", value: v }), /can't be written/);
  }
});

// Existing lines in the ways people write them.
const EXISTING = [
  "K=plain",
  "K=two words",
  "K=abc # note",
  "K='single quoted'",
  'K="double quoted"',
  'K="line1\\nline2"',
  "K=`backticks`",
  "K='C:\\temp\\'",
  'K="multi\nline"',
  "export K=exported",
];

test("the value the page shows is the one the readers load", () => {
  for (const text of EXISTING) {
    const [e] = parse(text).entries.filter((x) => x.kind === "var");
    const want = loaded(text, "K");
    assert.equal(want.dotenv, want.node, "the readers agree on " + JSON.stringify(text));
    assert.equal(e.value, want.dotenv, JSON.stringify(text));
  }
});

test("Edit: every writable value loads unchanged, whatever the line looked like", () => {
  for (const text of EXISTING) {
    for (const v of VALUES) {
      const edits = setValue(parse(text), 0, v);
      const changed = applyEdits(text, edits);
      assert.deepEqual(loaded(changed, "K"), both(v), JSON.stringify({ text, v, changed }));
    }
  }
});

test("Edit: appending to a value with \\n escapes keeps its line breaks and its escapes", () => {
  // The review's case: CONFIG="line1\nline2" (a literal backslash-n in the file).
  const text = 'CONFIG="line1\\nline2"\n';
  const [e] = parse(text).entries;
  assert.equal(e.value, "line1\nline2");
  const changed = applyEdits(text, setValue(parse(text), 0, e.value + "!"));
  assert.equal(changed, 'CONFIG="line1\\nline2!"\n');
  assert.deepEqual(loaded(changed, "CONFIG"), both("line1\nline2!"));
});

test("Edit: a value no quoting can hold is refused", () => {
  for (const v of UNWRITABLE) assert.throws(() => setValue(parse("K=x"), 0, v), /can't be written/);
});

test("switching off and on again gives back the same value", () => {
  for (const text of EXISTING) {
    const off = applyEdits(text, toggle(parse(text), 0, false));
    assert.equal(loaded(off, "K").dotenv, undefined, "off: " + JSON.stringify(off));
    assert.equal(loaded(off, "K").node, undefined, "off: " + JSON.stringify(off));
    const on = applyEdits(off, toggle(parse(off), 0, true));
    assert.deepEqual(loaded(on, "K"), loaded(text, "K"), JSON.stringify({ text, on }));
  }
});
