/*
 * Env Toggle: reading .env text, and the edits that turn variables on and off.
 *
 * Pure functions, no DOM. The page loads this as a classic script
 * (`window.EnvToggle`); the tests load it with require(). Offsets are UTF-16
 * code units, which is what `openidea.document.edit` expects.
 *
 * Turning a variable off inserts "# " before it; turning it on removes the
 * leading "#" marks. A multi-line quoted value is switched as one block, so
 * the file never ends up half commented.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.EnvToggle = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const KEY = "[A-Za-z_][A-Za-z0-9_.\\-]*";
  // KEY=value, optionally `export KEY=value`.
  const ACTIVE = new RegExp("^([ \\t]*)(export[ \\t]+)?(" + KEY + ")[ \\t]*=(.*)$");
  // # KEY=value (any number of #, any spacing after them).
  const COMMENTED = new RegExp("^([ \\t]*)(#+[ \\t]*)(export[ \\t]+)?(" + KEY + ")[ \\t]*=(.*)$");
  // The comment mark on a variable's first line, and on the lines of a multi-line value.
  const MARK_FIRST = /^([ \t]*)(#+[ \t]*)/;
  const MARK_MORE = /^([ \t]*)(#+ ?)/;
  const QUOTES = "\"'`";
  const INLINE_COMMENT = /^[ \t]*#[ \t]?(.*)$/;

  /** Lines with their start offsets; the line breaks are kept as they are. */
  function splitLines(text) {
    const lines = [];
    const re = /\r\n|\n|\r/g;
    let start = 0;
    let m;
    while ((m = re.exec(text))) {
      lines.push({ start, text: text.slice(start, m.index) });
      start = m.index + m[0].length;
    }
    lines.push({ start, text: text.slice(start) });
    return lines;
  }

  /*
   * Values are read and written the way the common readers load them: the
   * `dotenv` package and Node's own (`util.parseEnv`, `--env-file`).
   *
   * - Unquoted: up to the first `#` (the rest is a comment), trimmed. A
   *   backslash is just a backslash.
   * - '…' and `…`: exactly what is between the quotes, line breaks included;
   *   no escapes, so the value can't hold its own quote.
   * - "…": the same, except that \n (and, in dotenv, \r) become line breaks.
   *   dotenv lets \" stand inside; it keeps the backslash.
   */

  /**
   * Index of the quote `q` that closes a value, from `from`; -1 if none.
   * Only inside double quotes is a quote after a backslash not a closing one.
   */
  function closing(s, from, q) {
    for (let i = from; i < s.length; i++) {
      if (s[i] === "\\" && q === '"') {
        i++;
        continue;
      }
      if (s[i] === q) return i;
    }
    return -1;
  }

  /** An unquoted value as readers load it: up to the first `#`, trimmed; the rest is a comment. */
  function readBare(s) {
    const hash = s.indexOf("#");
    const value = (hash < 0 ? s : s.slice(0, hash)).trim();
    return { quote: "", open: false, value, comment: hash < 0 ? "" : s.slice(hash + 1).trim(), len: value.length };
  }

  /** What readers load from between double quotes: \n and \r become line breaks. */
  function decodeDouble(inner) {
    return inner.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
  }

  /**
   * What follows `=`: unquoted (read like readers do), or quoted with what is
   * between the quotes (`inner`, as written), whether the quote is still
   * open, and a trailing comment. `lead` and `len` place the value as written
   * (quotes included) in `raw`.
   */
  function readValue(raw) {
    const s = raw.replace(/^[ \t]+/, "");
    const lead = raw.length - s.length;
    const q = s.charAt(0);
    if (q && QUOTES.includes(q)) {
      const end = closing(s, 1, q);
      if (end < 0) return { quote: q, open: true, inner: s.slice(1), rest: s, comment: "", lead };
      const tail = INLINE_COMMENT.exec(s.slice(end + 1));
      return { quote: q, open: false, inner: s.slice(1, end), comment: tail ? tail[1].trim() : "", lead, len: end + 1 };
    }
    return Object.assign(readBare(s), { lead });
  }

  function variable(lines, i, enabled, key, exported, raw) {
    const first = readValue(raw);
    const span = [i];
    let quote = first.quote;
    let inner = first.inner;
    let value = first.value;
    let comment = first.comment;
    // Where the value is written in the text (quotes included), for setValue.
    const valueStart = lines[i].start + lines[i].text.length - raw.length + first.lead;
    let valueEnd = valueStart + first.len;
    if (first.open) {
      // A quoted value that goes on: the following lines up to the closing
      // quote are part of it (commented too, when the variable is off).
      const parts = [first.inner];
      let closedAt = -1;
      for (let j = i + 1; j < lines.length && closedAt < 0; j++) {
        let t = lines[j].text;
        let markLen = 0;
        if (!enabled) {
          const mark = MARK_MORE.exec(t);
          if (!mark) break;
          markLen = mark[0].length;
          t = t.slice(markLen);
        }
        span.push(j);
        const end = closing(t, 0, quote);
        if (end >= 0) {
          parts.push(t.slice(0, end));
          const tail = INLINE_COMMENT.exec(t.slice(end + 1));
          comment = tail ? tail[1].trim() : "";
          closedAt = lines[j].start + markLen + end + 1;
        } else {
          parts.push(t);
        }
      }
      if (closedAt >= 0) {
        inner = parts.join("\n");
        valueEnd = closedAt;
      } else {
        // Never closed: readers take the line as an unquoted value.
        span.length = 1;
        const bare = readBare(first.rest);
        quote = "";
        value = bare.value;
        comment = bare.comment;
        valueEnd = valueStart + bare.len;
      }
    }
    if (quote) value = quote === '"' ? decodeDouble(inner) : inner;
    return {
      kind: "var",
      line: i,
      lines: span,
      enabled,
      key,
      exported,
      // The value as readers load it.
      value,
      quote,
      // Line breaks written as \n inside double quotes: kept that way on edit.
      escapes: quote === '"' && /\\[nr]/.test(inner),
      comment,
      valueStart,
      valueEnd,
      multiline: span.length > 1,
      alternatives: 1,
      alsoOn: [],
    };
  }

  /** The text of a comment line without its decoration (# --- Section --- → "Section"). */
  function commentLabel(text) {
    return text.replace(/^[\s\-=*#~_+]+|[\s\-=*#~_+]+$/g, "");
  }

  /**
   * Cross-entry facts: how many lines define each key, which other lines
   * have the same key switched on, and how each comment reads (a divider,
   * a section heading or a note).
   */
  function annotate(entries) {
    const byKey = new Map();
    for (const e of entries) {
      if (e.kind !== "var") continue;
      if (!byKey.has(e.key)) byKey.set(e.key, []);
      byKey.get(e.key).push(e);
    }
    for (const group of byKey.values()) {
      for (const e of group) {
        e.alternatives = group.length;
        e.alsoOn = e.enabled ? group.filter((o) => o !== e && o.enabled).map((o) => o.line) : [];
      }
    }

    for (const e of entries) {
      if (e.kind !== "comment") continue;
      e.label = commentLabel(e.text);
      e.role = /[\p{L}\p{N}]/u.test(e.label) ? "note" : "divider";
    }
    // A heading is the first worded comment of a run that starts a block
    // (after a blank line or at the top) and leads straight into variables.
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].kind !== "comment") continue;
      const prev = entries[i - 1];
      if (prev && prev.kind !== "blank") continue;
      let j = i;
      while (j < entries.length && entries[j].kind === "comment") j++;
      const next = entries[j];
      if (!next || next.kind !== "var") continue;
      const run = entries.slice(i, j);
      const first = run.find((c) => c.role !== "divider");
      if (first && first.label.length <= 40 && !/[.!?:,;]$/.test(first.label)) {
        first.role = "heading";
        // The heading's comment block, as entry indices (for sections()).
        first.runStart = i;
        first.runEnd = j - 1;
        // The rules drawn around a heading (# -----) are its decoration.
        for (const c of run) if (c.role === "divider") c.role = "decoration";
      }
      i = j - 1;
    }
  }

  /**
   * Parses .env text into entries, one per variable (all its lines), comment,
   * blank or other line. `line` is the entry's first line (0-based).
   */
  function parse(text) {
    const lines = splitLines(text);
    const entries = [];
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].text;
      let m;
      let entry;
      if ((m = ACTIVE.exec(t))) entry = variable(lines, i, true, m[3], !!m[2], m[4]);
      else if ((m = COMMENTED.exec(t))) entry = variable(lines, i, false, m[4], !!m[3], m[5]);
      else if (/^[ \t]*$/.test(t)) entry = { kind: "blank", line: i, lines: [i] };
      else if (/^[ \t]*#/.test(t)) entry = { kind: "comment", line: i, lines: [i], text: t.replace(/^[ \t]*#+[ \t]?/, "") };
      else entry = { kind: "other", line: i, lines: [i], text: t };
      entries.push(entry);
      i = entry.lines[entry.lines.length - 1];
    }
    annotate(entries);
    return { text, lines, entries };
  }

  function entryAt(doc, line) {
    return doc.entries.find((e) => e.line === line) || null;
  }

  /** The edits that switch one variable on or off; none when it already is. */
  function switchEdits(doc, entry, on) {
    if (!entry || entry.kind !== "var" || entry.enabled === on) return [];
    return entry.lines.map((li, k) => {
      const L = doc.lines[li];
      if (on) {
        const m = (k === 0 ? MARK_FIRST : MARK_MORE).exec(L.text);
        const from = L.start + m[1].length;
        return { from, to: from + m[2].length, insert: "" };
      }
      // The first line is commented after its indent; the lines of a
      // multi-line value at column 0, so the value's own spacing survives.
      const at = k === 0 ? L.start + /^[ \t]*/.exec(L.text)[0].length : L.start;
      return { from: at, to: at, insert: "# " };
    });
  }

  /** Edits that switch the variable starting on `line` on (`true`) or off. */
  function toggle(doc, line, on) {
    return switchEdits(doc, entryAt(doc, line), on);
  }

  /** Edits that switch the variable on `line` on and every other line with its key off. */
  function onlyThis(doc, line) {
    const entry = entryAt(doc, line);
    if (!entry || entry.kind !== "var") return [];
    const edits = switchEdits(doc, entry, true);
    for (const other of doc.entries) {
      if (other !== entry && other.kind === "var" && other.key === entry.key && other.enabled) {
        edits.push(...switchEdits(doc, other, false));
      }
    }
    return edits.sort((a, b) => a.from - b.from);
  }

  /** Edits that switch every variable starting on one of `lines` on or off, as one sorted change. */
  function setMany(doc, lines, on) {
    const wanted = new Set(lines);
    const edits = [];
    for (const e of doc.entries) {
      if (e.kind === "var" && wanted.has(e.line)) edits.push(...switchEdits(doc, e, on));
    }
    return edits.sort((a, b) => a.from - b.from);
  }

  /**
   * The file's groups. A group is a heading and the block of lines right
   * under it, up to the first blank line, so a blank line always ends a
   * group. `from` and `to` are its entry indices (`to` exclusive, from the
   * heading's comment block on); `end` is its last line, where a new variable
   * goes. Variables in no group are `ungrouped`, in file order.
   */
  function sections(doc) {
    const ents = doc.entries;
    const list = [];
    const grouped = new Set();
    ents.forEach((h) => {
      if (h.kind !== "comment" || h.role !== "heading") return;
      let to = h.runEnd + 1;
      while (to < ents.length && ents[to].kind !== "blank") to++;
      const vars = ents.slice(h.runEnd + 1, to).filter((e) => e.kind === "var");
      for (const v of vars) grouped.add(v);
      const last = ents[to - 1];
      list.push({ line: h.line, label: h.label, vars, from: h.runStart, to, end: last.lines[last.lines.length - 1] });
    });
    return { sections: list, ungrouped: ents.filter((e) => e.kind === "var" && !grouped.has(e)) };
  }

  /** What goes before a new block at the end of `text`: nothing, or line breaks up to one blank line. */
  function blockBreak(text, eol) {
    if (/^\s*$/.test(text)) return "";
    if (/(\r?\n|\r)[ \t]*(\r?\n|\r)$/.test(text)) return "";
    if (/(\r?\n|\r)$/.test(text)) return eol;
    return eol + eol;
  }

  const KEY_ONLY = new RegExp("^" + KEY + "$");

  function isKey(key) {
    return KEY_ONLY.test(key);
  }

  // Ways to write a value so readers load exactly it; each returns null when it can't.
  // No way escapes anything: readers don't undo escapes (but \n in "…").

  /** Unquoted: no #, line break or space at either end, not starting with a quote. `spaces`: allow spaces inside. */
  function asBare(v, spaces) {
    if (v === "") return "";
    if (/[#\r\n]/.test(v) || /^\s|\s$/.test(v) || QUOTES.includes(v[0])) return null;
    if (!spaces && /\s/.test(v)) return null;
    return v;
  }

  /** '…': anything but a single quote. */
  function asSingle(v) {
    return /['\r]/.test(v) ? null : "'" + v + "'";
  }

  /** `…`: anything but a backtick. Last resort: not every reader knows backticks. */
  function asBacktick(v) {
    return /[`\r]/.test(v) ? null : "`" + v + "`";
  }

  /**
   * "…": no double quote and no backslash (readers turn \n into a line break).
   * Line breaks are written as \n when `escapes`, as they are otherwise.
   */
  function asDouble(v, escapes) {
    if (/["\\\r]/.test(v)) return null;
    return '"' + (escapes ? v.replace(/\n/g, "\\n") : v) + '"';
  }

  /**
   * `value` as written after `=`, so that readers load exactly it; null when
   * no way of writing it does (it needs quotes and holds ', " and `, or a
   * carriage return). With `was` (an entry), its way of writing comes first.
   */
  function encodeValue(value, was) {
    const v = String(value);
    // Node reads `export K=` as a key named "export K"; `export K=""` it reads right.
    if (v === "" && was && was.exported) return '""';
    const ways = [];
    const double = (x) => asDouble(x, false);
    if (was && was.quote) {
      // A quoted value stays quoted while some quotes hold it.
      if (was.quote === '"') ways.push((x) => asDouble(x, was.escapes));
      else if (was.quote === "'") ways.push(asSingle);
      else ways.push(asBacktick);
      ways.push(double, asSingle, (x) => asBare(x, true), asBacktick);
    } else {
      // Quotes for anything with spaces, so the file also reads well in a shell.
      ways.push((x) => asBare(x, false), asSingle, double, (x) => asBare(x, true), asBacktick);
    }
    for (const way of ways) {
      const written = way(v);
      if (written !== null) return written;
    }
    return null;
  }

  /** The value as it would be written for a new variable; null when it can't be written. */
  function formatValue(value) {
    return encodeValue(value);
  }

  /** Whether `value` can be written so readers load it unchanged. */
  function canWrite(value) {
    return encodeValue(value) !== null;
  }

  const UNWRITABLE = "This value can't be written so .env readers load it unchanged: it needs quotes but holds ', \" and `.";

  /**
   * The edit that adds `key=value` (commented out unless `on`): at the end of
   * the group whose heading is on line `section`; with `section` null, after
   * the last variable in no group (or in a block of its own at the end); or
   * under a new heading `newSection` at the end of the file. Returns
   * `{ edits, line }`, `line` being where the new variable starts in the
   * changed text.
   */
  function addVariable(doc, opts) {
    const key = opts.key;
    const value = opts.value == null ? "" : String(opts.value);
    const on = opts.on !== false;
    const section = opts.section == null ? null : opts.section;
    const newSection = (opts.newSection || "").trim().replace(/[.!?:,;]+$/, "");
    if (!isKey(key)) throw new Error("not a valid variable name: " + key);
    const written = encodeValue(value);
    if (written === null) throw new Error(UNWRITABLE);

    const text = doc.text;
    const eol = /\r\n/.test(text) ? "\r\n" : "\n";
    const mark = on ? "" : "# ";
    const body = mark + key + "=" + written.split(/\r\n|\n|\r/).join(eol + mark);

    let at;
    let before = "";
    let heading = "";
    let after = "";
    const s = sections(doc);
    let endLine = -1;
    if (newSection) {
      heading = "# " + newSection + eol;
    } else if (section !== null) {
      const target = s.sections.find((x) => x.line === section);
      if (!target) throw new Error("no group on line " + (section + 1));
      endLine = target.end;
    } else if (s.ungrouped.length) {
      const last = s.ungrouped[s.ungrouped.length - 1];
      endLine = last.lines[last.lines.length - 1];
    }
    if (endLine >= 0) {
      // Right after the line, in the same block.
      const L = doc.lines[endLine];
      at = L.start + L.text.length;
      before = eol;
    } else {
      // A block of its own at the end, after a blank line.
      at = text.length;
      before = blockBreak(text, eol);
      after = eol;
    }
    const insert = before + heading + body + after;
    const start = at + before.length + heading.length;
    const changed = text.slice(0, at) + insert + text.slice(at);
    return { edits: [{ from: at, to: at, insert }], line: splitLines(changed.slice(0, start)).length - 1 };
  }

  /**
   * The edit that changes the value (as readers load it) of the variable
   * starting on `line`. The rest of the line stays as written: indent, `#`,
   * `export`, key, spacing and a trailing comment; the value keeps its way of
   * writing (quotes, \n escapes) when it still holds it. Throws when the
   * value can't be written (see canWrite).
   */
  function setValue(doc, line, value) {
    const e = entryAt(doc, line);
    if (!e || e.kind !== "var") return [];
    const v = String(value);
    if (v === e.value) return [];
    const written = encodeValue(v, e);
    if (written === null) throw new Error(UNWRITABLE);
    const eol = /\r\n/.test(doc.text) ? "\r\n" : "\n";
    // The lines of a multi-line value are commented too while it's off.
    const insert = written.split(/\r\n|\n|\r/).join(eol + (e.enabled ? "" : "# "));
    return [{ from: e.valueStart, to: e.valueEnd, insert }];
  }

  /** `text` with sorted, non-overlapping `{ from, to, insert }` edits applied. */
  function applyEdits(text, edits) {
    let out = text;
    for (const e of [...edits].sort((a, b) => b.from - a.from)) {
      out = out.slice(0, e.from) + e.insert + out.slice(e.to);
    }
    return out;
  }

  return { parse, toggle, onlyThis, setMany, sections, addVariable, setValue, formatValue, canWrite, UNWRITABLE, isKey, applyEdits, commentLabel };
});
