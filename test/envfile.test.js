// Run with: npm test  (or: node --test)
const test = require("node:test");
const assert = require("node:assert/strict");
const { parse, toggle, onlyThis, applyEdits, commentLabel } = require("../web/envfile.js");

/** Switches the variable on `line` and returns the new text. */
function flip(text, line, on) {
  return applyEdits(text, toggle(parse(text), line, on));
}

const vars = (text) => parse(text).entries.filter((e) => e.kind === "var");

test("reads active and commented variables", () => {
  const [a, b, c, d] = vars("A=1\n# B=2\n#C=3\nexport D=\"four\" # note\n");
  assert.deepEqual([a.key, a.enabled, a.value], ["A", true, "1"]);
  assert.deepEqual([b.key, b.enabled, b.value], ["B", false, "2"]);
  assert.deepEqual([c.key, c.enabled, c.value], ["C", false, "3"]);
  assert.deepEqual([d.key, d.enabled, d.exported, d.value, d.quote, d.comment], ["D", true, true, "four", '"', "note"]);
});

test("prose comments stay comments", () => {
  const kinds = parse("# Database settings\n# set DEBUG=true for logs\n# e.g. FOO=bar\n# Note: x=1\n")
    .entries.map((e) => e.kind);
  assert.deepEqual(kinds, ["comment", "comment", "comment", "comment", "blank"]);
});

test("unchecking comments a line out, checking restores it", () => {
  const text = "A=1\n  B=2\nexport C=3\n";
  const off = flip(text, 1, false);
  assert.equal(off, "A=1\n  # B=2\nexport C=3\n");
  assert.equal(flip(off, 1, true), text);
  assert.equal(flip(text, 2, false), "A=1\n  B=2\n# export C=3\n");
});

test("checking removes any number of # and spaces", () => {
  assert.equal(flip("##   A=1", 0, true), "A=1");
  assert.equal(flip("#A=1", 0, true), "A=1");
  assert.equal(flip("  # A=1", 0, true), "  A=1");
});

test("switching to the state it is in changes nothing", () => {
  assert.deepEqual(toggle(parse("A=1"), 0, true), []);
  assert.deepEqual(toggle(parse("# A=1"), 0, false), []);
  assert.deepEqual(toggle(parse("# just a note"), 0, true), []);
});

test("keeps CRLF line breaks", () => {
  assert.equal(flip("A=1\r\nB=2\r\n", 1, false), "A=1\r\n# B=2\r\n");
});

test("unquoted values: # after a space starts a comment", () => {
  const [a, b] = vars("A=abc # the comment\nB=abc#not-a-comment");
  assert.deepEqual([a.value, a.comment], ["abc", "the comment"]);
  assert.deepEqual([b.value, b.comment], ["abc#not-a-comment", ""]);
});

test("multi-line quoted values switch as one block", () => {
  const text = 'KEY="-----BEGIN\n  abc\n-----END"\nNEXT=1\n';
  const [key, next] = vars(text);
  assert.equal(key.multiline, true);
  assert.deepEqual(key.lines, [0, 1, 2]);
  assert.equal(key.value, "-----BEGIN\n  abc\n-----END");
  assert.equal(next.key, "NEXT");

  const off = flip(text, 0, false);
  assert.equal(off, '# KEY="-----BEGIN\n#   abc\n# -----END"\nNEXT=1\n');
  const [offKey] = vars(off);
  assert.deepEqual([offKey.enabled, offKey.lines, offKey.value], [false, [0, 1, 2], key.value]);
  assert.equal(flip(off, 0, true), text);
});

test("an unclosed quote is a single line", () => {
  const [a, b] = vars('A="oops\nB=2');
  assert.deepEqual([a.lines, a.value, b.key], [[0], "oops", "B"]);
});

test("escaped quotes do not close a value", () => {
  const [a] = vars('A="say \\"hi\\"" # c');
  assert.deepEqual([a.value, a.comment], ['say \\"hi\\"', "c"]);
});

test("duplicate keys: alternatives and lines also on", () => {
  const entries = vars("URL=a\n# URL=b\nURL=c\nOTHER=1");
  assert.deepEqual(entries.map((e) => e.alternatives), [3, 3, 3, 1]);
  assert.deepEqual(entries.map((e) => e.alsoOn), [[2], [], [0], []]);
});

test("only this: switches one alternative on and the rest off, in one sorted change", () => {
  const text = "URL=a\n# URL=b\nURL=c\nOTHER=1\n";
  const edits = onlyThis(parse(text), 1);
  assert.deepEqual(
    edits.map((e) => e.from),
    [...edits.map((e) => e.from)].sort((x, y) => x - y),
  );
  assert.equal(applyEdits(text, edits), "# URL=a\nURL=b\n# URL=c\nOTHER=1\n");
});

test("comment roles: dividers, headings and notes", () => {
  const text = [
    "# ----------",
    "# Database",
    "# ----------",
    "DB_HOST=localhost",
    "",
    "# This explains the next variable in a full sentence.",
    "API_KEY=x",
    "",
    "# Trailing note",
  ].join("\n");
  const roles = parse(text)
    .entries.filter((e) => e.kind === "comment")
    .map((e) => [e.label, e.role]);
  assert.deepEqual(roles, [
    ["", "decoration"],
    ["Database", "heading"],
    ["", "decoration"],
    ["This explains the next variable in a full sentence.", "note"],
    ["Trailing note", "note"],
  ]);
  assert.equal(commentLabel("=== Redis ==="), "Redis");
  // A rule on its own (no heading in its run) stays a divider.
  const lone = parse("A=1\n\n# -----\nB=2").entries.find((e) => e.kind === "comment");
  assert.equal(lone.role, "divider");
});

test("UTF-16 offsets with non-ASCII text", () => {
  const text = "# 🎉 Party\nEMOJI=😀\nB=2";
  assert.equal(flip(text, 2, false), "# 🎉 Party\nEMOJI=😀\n# B=2");
});

// Groups and adding ---------------------------------------------------------

const { setMany, sections, addVariable, formatValue } = require("../web/envfile.js");

/** Adds a variable and returns [new text, the new variable's line]. */
function add(text, opts) {
  const { edits, line } = addVariable(parse(text), opts);
  return [applyEdits(text, edits), line];
}

const GROUPED = [
  "TOP=1", //                0
  "", //                     1
  "# ---------", //          2
  "# Staging", //            3
  "# ---------", //          4
  "API=https://staging", //  5
  "# DEBUG=1", //            6
  "", //                     7
  "# Local", //              8
  "API=http://localhost", // 9
  "", //                     10
].join("\n");

test("sections: each heading with its variables, and what is in no group", () => {
  const s = sections(parse(GROUPED));
  assert.deepEqual(s.ungrouped.map((v) => v.key), ["TOP"]);
  assert.deepEqual(
    s.sections.map((x) => [x.label, x.line, x.vars.map((v) => v.line), x.end, x.from, x.to]),
    [
      ["Staging", 3, [5, 6], 6, 2, 7],
      ["Local", 8, [9], 9, 8, 10],
    ],
  );
});

test("sections: a blank line ends a group", () => {
  // A heading without a space, then two blocks: only the first is the group.
  const text = ["#dev", "CORE_PRIMARY=a", "CORE_EU=b", "", "USERS_EU=c", "INSPIRATION=d", ""].join("\n");
  const doc = parse(text);
  const s = sections(doc);
  assert.deepEqual(
    s.sections.map((x) => [x.label, x.vars.map((v) => v.key)]),
    [["dev", ["CORE_PRIMARY", "CORE_EU"]]],
  );
  assert.deepEqual(s.ungrouped.map((v) => v.key), ["USERS_EU", "INSPIRATION"]);
  // Switching the group off leaves the next block alone.
  const off = applyEdits(text, setMany(doc, s.sections[0].vars.map((v) => v.line), false));
  assert.equal(off, ["#dev", "# CORE_PRIMARY=a", "# CORE_EU=b", "", "USERS_EU=c", "INSPIRATION=d", ""].join("\n"));
});

test("setMany: a group on or off in one sorted change", () => {
  const doc = parse(GROUPED);
  const staging = sections(doc).sections[0];
  const on = applyEdits(GROUPED, setMany(doc, staging.vars.map((v) => v.line), true));
  assert.match(on, /^API=https:\/\/staging\nDEBUG=1$/m);
  const off = applyEdits(GROUPED, setMany(doc, staging.vars.map((v) => v.line), false));
  assert.match(off, /^# API=https:\/\/staging\n# DEBUG=1$/m);
  assert.deepEqual(setMany(doc, [6], false), [], "already off");
});

test("add: to the end of a group, before its blank lines", () => {
  const [text, line] = add(GROUPED, { key: "NEW", value: "x", section: 3 });
  assert.equal(text.split("\n")[7], "NEW=x");
  assert.equal(line, 7);
  assert.deepEqual(sections(parse(text)).sections[0].vars.map((v) => v.key), ["API", "DEBUG", "NEW"]);
});

test("add: switched off, with no group, and as a new group", () => {
  const [off, offLine] = add(GROUPED, { key: "TOP2", value: "2", on: false, section: null });
  assert.deepEqual(off.split("\n").slice(0, 3), ["TOP=1", "# TOP2=2", ""]);
  assert.equal(offLine, 1);

  const [grouped, line] = add(GROUPED, { key: "API", value: "https://prod", newSection: "Production" });
  assert.ok(grouped.endsWith("\n\n# Production\nAPI=https://prod\n"), JSON.stringify(grouped.slice(-40)));
  assert.equal(grouped.split("\n")[line], "API=https://prod");
  assert.equal(sections(parse(grouped)).sections[2].label, "Production");
});

test("add: no group goes after the last ungrouped variable, or in a block of its own", () => {
  // After the ungrouped block that follows a group, not into the group.
  const [after] = add("#dev\nA=1\n\nB=2\n", { key: "C", value: "3" });
  assert.equal(after, "#dev\nA=1\n\nB=2\nC=3\n");
  // Only grouped variables: a new block at the end, outside the group.
  const [text, line] = add("# Database\nDB=1\n", { key: "A", value: "1" });
  assert.equal(text, "# Database\nDB=1\n\nA=1\n");
  assert.equal(line, 3);
  assert.deepEqual(sections(parse(text)).ungrouped.map((v) => v.key), ["A"]);
  assert.equal(add("# Database\nDB=1", { key: "A", value: "1" })[0], "# Database\nDB=1\n\nA=1\n");
  assert.equal(add("", { key: "A", value: "1" })[0], "A=1\n");
  assert.equal(add("", { key: "A", value: "1", newSection: "Things" })[0], "# Things\nA=1\n");
  assert.equal(add("B=2", { key: "A", value: "1", newSection: "Things" })[0], "B=2\n\n# Things\nA=1\n");
});

test("add: keeps CRLF and rejects bad names", () => {
  assert.equal(add("A=1\r\n", { key: "B", value: "2" })[0], "A=1\r\nB=2\r\n");
  assert.throws(() => add("", { key: "1BAD", value: "x" }));
  assert.throws(() => add("", { key: "HAS SPACE", value: "x" }));
});

test("formatValue: quotes only when needed, and reads back the same", () => {
  assert.equal(formatValue(""), "");
  assert.equal(formatValue("postgres://u:p@h:5432/db?ssl=true"), "postgres://u:p@h:5432/db?ssl=true");
  assert.equal(formatValue("two words"), '"two words"');
  assert.equal(formatValue("a #b"), '"a #b"');
  assert.equal(formatValue('say "hi"'), "'say \"hi\"'");
  for (const v of ["two words", "a #b", 'say "hi"', "it's", "C:\\path\\x", "multi\nline"]) {
    const [text] = add("", { key: "K", value: v });
    const read = vars(text)[0];
    assert.equal(read.key, "K", v);
    if (!/\\/.test(v)) assert.equal(read.value, v, v);
  }
});

// Editing values -------------------------------------------------------------

const { setValue } = require("../web/envfile.js");

/** Sets the value of the variable on `line` and returns the new text. */
function edit(text, line, value) {
  return applyEdits(text, setValue(parse(text), line, value));
}

test("setValue: replaces only the value", () => {
  assert.equal(edit("A=1\nB=2", 1, "3"), "A=1\nB=3");
  assert.equal(edit("export A = 1", 0, "2"), "export A = 2");
  assert.equal(edit("  # A=1", 0, "2"), "  # A=2", "a line that is off stays off");
  assert.equal(edit("A=1 # the note", 0, "two words"), 'A="two words" # the note');
  assert.equal(edit("A=", 0, "x"), "A=x");
  assert.equal(edit("A=x", 0, ""), "A=");
});

test("setValue: keeps the quotes when they still fit", () => {
  assert.equal(edit('A="x" # n', 0, "y"), 'A="y" # n');
  assert.equal(edit("A='x'", 0, "y z"), "A='y z'");
  assert.equal(edit('A="x"', 0, ""), 'A=""');
  // A value the old quotes can't hold gets quotes that can.
  assert.equal(edit("A='x'", 0, "it's"), 'A="it\'s"');
});

test("setValue: multi-line values, on and off", () => {
  const on = 'K="l1\nl2"\nB=2';
  assert.equal(edit(on, 0, "short"), 'K="short"\nB=2');
  assert.equal(edit("K=x\nB=2", 0, "a\nb"), 'K="a\nb"\nB=2');
  const off = '# K="l1\n# l2" # note\nB=2';
  assert.equal(edit(off, 0, "a\nb\nc"), '# K="a\n# b\n# c" # note\nB=2');
  assert.equal(edit("# K=x\r\nB=2", 0, "a\nb"), '# K="a\r\n# b"\r\nB=2');
  // What was written reads back the same.
  const [k] = vars(edit(off, 0, "a\nb\nc"));
  assert.deepEqual([k.enabled, k.value, k.comment, k.lines], [false, "a\nb\nc", "note", [0, 1, 2]]);
});

test("setValue: no change for the same value, a non-variable or an unknown line", () => {
  assert.deepEqual(setValue(parse("A=1"), 0, "1"), []);
  assert.deepEqual(setValue(parse("# note"), 0, "x"), []);
  assert.deepEqual(setValue(parse("A=1"), 5, "x"), []);
});
