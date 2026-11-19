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

  /** Index of the closing quote `q` in `s` from `from`, skipping backslash escapes; -1 if none. */
  function closing(s, from, q) {
    for (let i = from; i < s.length; i++) {
      if (s[i] === "\\") {
        i++;
        continue;
      }
      if (s[i] === q) return i;
    }
    return -1;
  }

  /**
   * What follows `=`: the value (unquoted), its quote, whether the quote is
   * still open, and a trailing comment. `lead` and `len` place the value as
   * written (quotes included) in `raw`.
   */
  function readValue(raw) {
    const s = raw.replace(/^[ \t]+/, "");
    const lead = raw.length - s.length;
    const q = s.charAt(0);
    if (q && QUOTES.includes(q)) {
      const end = closing(s, 1, q);
      if (end < 0) return { value: s.slice(1), quote: q, open: true, comment: "", lead, len: s.replace(/[ \t]+$/, "").length };
      const tail = INLINE_COMMENT.exec(s.slice(end + 1));
      return { value: s.slice(1, end), quote: q, open: false, comment: tail ? tail[1].trim() : "", lead, len: end + 1 };
    }
    // Unquoted: a # after whitespace starts a comment.
    const hash = /[ \t]#/.exec(s);
    const value = (hash ? s.slice(0, hash.index) : s).trim();
    return {
      value,
      quote: "",
      open: false,
      comment: hash ? s.slice(hash.index).replace(/^[ \t]*#[ \t]?/, "").trim() : "",
      lead,
      len: value.length,
    };
  }

  function variable(lines, i, enabled, key, exported, raw) {
    const first = readValue(raw);
    const span = [i];
    let value = first.value;
    let comment = first.comment;
    // Where the value is written in the text (quotes included), for setValue.
    const valueStart = lines[i].start + lines[i].text.length - raw.length + first.lead;
    let valueEnd = valueStart + first.len;
    if (first.open) {
      // A quoted value that goes on: the following lines up to the closing
      // quote are part of it (commented too, when the variable is off).
      const parts = [first.value];
      let closed = false;
      let closedAt = -1;
      for (let j = i + 1; j < lines.length && !closed; j++) {
        let t = lines[j].text;
        let markLen = 0;
        if (!enabled) {
          const mark = MARK_MORE.exec(t);
          if (!mark) break;
          markLen = mark[0].length;
          t = t.slice(markLen);
        }
        span.push(j);
        const end = closing(t, 0, first.quote);
        if (end >= 0) {
          parts.push(t.slice(0, end));
          const tail = INLINE_COMMENT.exec(t.slice(end + 1));
          comment = tail ? tail[1].trim() : "";
          closed = true;
          closedAt = lines[j].start + markLen + end + 1;
        } else {
          parts.push(t);
        }
      }
      if (closed) {
        value = parts.join("\n");
        valueEnd = closedAt;
      } else {
        span.length = 1; // never closed: just this line
      }
    }
    return {
      kind: "var",
      line: i,
      lines: span,
      enabled,
      key,
      exported,
      value,
      quote: first.quote,
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

  /** A value as it is written after `=`: bare when it can be, quoted otherwise. */
  function formatValue(value) {
    if (value === "") return "";
    if (/^[^\s#"'`\\]+$/.test(value)) return value;
    if (!/["\\]/.test(value)) return '"' + value + '"';
    if (!/['\r\n]/.test(value) && !value.endsWith("\\")) return "'" + value + "'";
    return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  }

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

    const text = doc.text;
    const eol = /\r\n/.test(text) ? "\r\n" : "\n";
    const mark = on ? "" : "# ";
    const body = mark + key + "=" + formatValue(value).split(/\r\n|\n|\r/).join(eol + mark);

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

  /** `value` in the quotes `q`, when they hold it as it is; null when not. */
  function withQuote(value, q) {
    if (value.includes(q) || value.includes("\\")) return null;
    return q + value + q;
  }

  /**
   * The edit that changes the value of the variable starting on `line`. The
   * rest of the line stays as written: indent, `#`, `export`, key, spacing and
   * a trailing comment; the value keeps its quotes when they still fit.
   */
  function setValue(doc, line, value) {
    const e = entryAt(doc, line);
    if (!e || e.kind !== "var") return [];
    const v = String(value);
    if (v === e.value) return [];
    const eol = /\r\n/.test(doc.text) ? "\r\n" : "\n";
    const written = (e.quote && withQuote(v, e.quote)) || formatValue(v);
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

  return { parse, toggle, onlyThis, setMany, sections, addVariable, setValue, formatValue, isKey, applyEdits, commentLabel };
});
