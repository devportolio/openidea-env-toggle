/*
 * Env Toggle page: the checkbox view of a .env file, opened by OpenIDEA beside
 * the file's text editor (or alone, in Preview Only). It reads the document
 * through `window.openidea.document`, and every action becomes one undoable
 * text edit, so the text editor, Undo and Save follow.
 *
 * Groups are the file's own sections (a `# Heading` comment and the variables
 * under it), so they live in the file like everything else.
 */
(function () {
  "use strict";

  const E = window.EnvToggle;
  const bridge = window.openidea;
  const app = document.getElementById("app");

  if (!bridge || !bridge.document) {
    app.className = "outside";
    app.textContent = "This page runs inside OpenIDEA.";
    return;
  }

  const MAX_KEY_CH = 32;
  const MAX_GROUP_NAME = 40;
  const MASK = "••••••••";
  const NO_GROUP = "";
  const NEW_GROUP = "new";

  let doc = E.parse("");
  let version = 0;
  let readOnly = false;
  let fileName = ".env";
  let filter = "";
  let hideValues = false;
  let queue = Promise.resolve();
  let frame = 0;
  let bannerTimer = 0;
  // The line of a variable just added, to scroll to and highlight once.
  let flashLine = -1;
  // Shift-click: the last checkbox clicked, and the range start for the change that follows.
  let lastBoxLine = null;
  let rangeFrom = null;
  // Whether the user set the add form's On box themselves.
  let onTouched = false;
  // The value being edited in place: { line, key, draft, multiline, sel }.
  // It lives here, not in the DOM, so a re-render keeps the draft.
  let editing = null;
  // True while the list is rebuilt: removing the editor then is not leaving it.
  let rendering = false;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(cls, text, title) {
    const b = el("button", cls, text);
    b.type = "button";
    if (title) b.title = title;
    return b;
  }

  function input(cls, placeholder, label) {
    const i = el("input", cls);
    i.type = "text";
    i.placeholder = placeholder;
    i.spellcheck = false;
    i.autocomplete = "off";
    i.setAttribute("aria-label", label);
    return i;
  }

  // Skeleton ----------------------------------------------------------------

  const bar = el("header", "bar");
  const nameEl = el("span", "name");
  const countEl = el("span", "count");
  const roEl = el("span", "badge readonly", "Read-only");
  roEl.hidden = true;
  const search = el("input", "filter");
  search.type = "search";
  search.placeholder = "Filter";
  search.setAttribute("aria-label", "Filter variables");
  search.spellcheck = false;
  const addBtn = button("add", "+ Add", "Add a variable");
  const maskBtn = button("mask", "Hide values", "Hide values, for screen sharing");
  maskBtn.setAttribute("aria-pressed", "false");
  bar.append(nameEl, countEl, roEl, el("span", "spacer"), search, addBtn, maskBtn);

  // The add form. Not a <form>: the page's sandbox doesn't allow submitting one.
  const adder = el("div", "adder");
  adder.hidden = true;
  adder.setAttribute("role", "group");
  adder.setAttribute("aria-label", "Add a variable");
  const keyIn = input("key-in", "NAME", "Name");
  const valIn = input("val-in", "value", "Value");
  const groupSel = el("select", "group-sel");
  groupSel.setAttribute("aria-label", "Group");
  const newGroupIn = input("group-in", "New group name", "New group name");
  newGroupIn.maxLength = MAX_GROUP_NAME;
  newGroupIn.hidden = true;
  const onBox = el("input");
  onBox.type = "checkbox";
  onBox.checked = true;
  const onLabel = el("label", "on-label");
  onLabel.append(onBox, document.createTextNode(" On"));
  onLabel.title = "Unchecked adds the line commented out";
  const addOk = button("primary", "Add");
  const addCancel = button("", "Cancel");
  const hint = el("div", "hint");
  hint.setAttribute("aria-live", "polite");
  const row1 = el("div", "fields");
  row1.append(keyIn, el("span", "eq", "="), valIn);
  const row2 = el("div", "fields");
  row2.append(el("span", "in", "in"), groupSel, newGroupIn, onLabel, el("span", "spacer"), addCancel, addOk);
  adder.append(row1, row2, hint);

  const banner = el("div", "banner");
  banner.hidden = true;
  banner.setAttribute("role", "status");

  const list = el("div", "list");
  list.setAttribute("role", "list");

  app.append(bar, adder, banner, list);

  // Rendering ---------------------------------------------------------------

  /** The value being edited: a text field, or a text box for a multi-line value. */
  function valueEditor(e) {
    const ed = el(editing.multiline ? "textarea" : "input", "val-edit");
    if (!editing.multiline) ed.type = "text";
    else ed.rows = Math.min(Math.max(editing.draft.split("\n").length, 2), 8);
    ed.value = editing.draft;
    ed.spellcheck = false;
    ed.autocomplete = "off";
    ed.dataset.line = String(e.line);
    ed.setAttribute("aria-label", "Value of " + e.key);
    ed.title = editing.multiline ? "⌘↩ or Ctrl+↩ saves, Esc cancels" : "↩ saves, Esc cancels";
    if (editing.invalid) {
      ed.classList.add("invalid");
      ed.setAttribute("aria-invalid", "true");
      ed.title = E.UNWRITABLE;
    }
    return ed;
  }

  function valueCell(e) {
    const cell = el("span", "cell");
    if (editing && editing.line === e.line) {
      cell.classList.add("editing");
      cell.append(valueEditor(e));
      return cell;
    }
    // A button, so clicking the value edits it instead of switching the row.
    const editable = !readOnly && !hideValues;
    const val = editable ? button("val") : el("span", "val");
    val.dataset.line = String(e.line);
    cell.append(val);
    if (hideValues && e.value) {
      val.textContent = MASK;
      val.classList.add("masked");
    } else if (!e.value) {
      val.textContent = "empty";
      val.classList.add("empty");
    } else {
      const parts = e.value.split("\n");
      val.textContent = parts[0];
      val.title = e.value;
      if (parts.length > 1) cell.append(el("span", "more", "+" + (parts.length - 1) + (parts.length === 2 ? " line" : " lines")));
    }
    if (editable) {
      val.title = (val.title ? val.title + "\n\n" : "") + "Click to edit";
      val.setAttribute("aria-label", "Edit the value of " + e.key);
    }
    if (e.comment) {
      const c = el("span", "comment", "# " + e.comment);
      c.title = e.comment;
      cell.append(c);
    }
    return cell;
  }

  function row(e) {
    const r = el("label", "row " + (e.enabled ? "on" : "off"));
    r.dataset.line = String(e.line);
    r.setAttribute("role", "listitem");
    if (e.line === flashLine) r.classList.add("flash");

    const box = el("input");
    box.type = "checkbox";
    box.checked = e.enabled;
    box.disabled = readOnly;
    box.dataset.line = String(e.line);
    box.setAttribute("aria-label", e.key + (e.alternatives > 1 ? ", line " + (e.line + 1) : ""));

    const key = el("span", "key");
    if (e.exported) key.append(el("span", "export", "export "));
    key.append(document.createTextNode(e.key));
    key.title = e.key + " · line " + (e.line + 1) + (e.multiline ? "–" + (e.lines[e.lines.length - 1] + 1) : "");

    const extras = el("span", "extras");
    if (e.alsoOn.length) {
      const dup = el("span", "badge dup", "also on line " + e.alsoOn.map((l) => l + 1).join(", "));
      dup.title = e.key + " is switched on more than once";
      extras.append(dup);
    }
    // "Only this" for keys with alternatives, when it would change something.
    if (!readOnly && e.alternatives > 1 && (!e.enabled || e.alsoOn.length)) {
      const only = button("only", "Only this", "Switch this " + e.key + " on and the other " + e.key + " lines off");
      only.dataset.line = String(e.line);
      extras.append(only);
    }

    r.append(box, key, valueCell(e), extras);
    return r;
  }

  /** A section heading: a checkbox for the whole group, its name, and + Add. */
  function headingEl(e, section) {
    const vars = section ? section.vars : [];
    const h = el(vars.length ? "label" : "div", "heading");
    h.dataset.line = String(e.line);
    if (vars.length) {
      const on = vars.filter((v) => v.enabled).length;
      const box = el("input", "group-box");
      box.type = "checkbox";
      box.checked = on === vars.length;
      box.indeterminate = on > 0 && on < vars.length;
      box.disabled = readOnly;
      box.dataset.group = String(e.line);
      box.setAttribute("aria-label", "All of " + e.label);
      h.append(box, el("span", "label", e.label), el("span", "group-count", on + "/" + vars.length));
      h.title = "Switch every variable in " + e.label + " on or off";
    } else {
      h.append(el("span", "group-gap"), el("span", "label", e.label));
    }
    if (!readOnly) {
      const add = button("add-here", "+ Add", "Add a variable to " + e.label);
      add.dataset.group = String(e.line);
      h.append(add);
    }
    return h;
  }

  function commentEl(e, byHeading) {
    if (e.role === "decoration") return null;
    if (e.role === "divider") return el("div", "divider");
    if (e.role === "heading") return headingEl(e, byHeading.get(e.line));
    return el("div", "note", e.text);
  }

  function matches(e, q) {
    if (e.key.toLowerCase().includes(q)) return true;
    if (e.comment.toLowerCase().includes(q)) return true;
    return !hideValues && e.value.toLowerCase().includes(q);
  }

  function render() {
    frame = 0;

    // An edit whose variable is gone (the text changed under it), or that
    // can't go on, ends without saving.
    if (editing && (readOnly || hideValues || !doc.entries.some((e) => e.kind === "var" && e.line === editing.line && e.key === editing.key))) {
      editing = null;
    }

    // Remember what had focus, to give it back after the rebuild.
    const active = document.activeElement;
    const inList = !!(active && list.contains(active) && active.dataset);
    if (editing && inList && active.classList.contains("val-edit")) editing.sel = [active.selectionStart, active.selectionEnd];
    let focusSel = null;
    if (inList && active.dataset.group !== undefined) {
      focusSel = (active.classList.contains("add-here") ? "button.add-here" : "input") + '[data-group="' + active.dataset.group + '"]';
    } else if (inList && active.dataset.line !== undefined) {
      const cls = active.classList;
      const kind = cls.contains("only") ? "button.only" : cls.contains("val") || cls.contains("val-edit") ? "button.val" : "input[type='checkbox']";
      focusSel = kind + '[data-line="' + active.dataset.line + '"]';
    }

    const vars = doc.entries.filter((e) => e.kind === "var");
    const on = vars.filter((e) => e.enabled).length;
    nameEl.textContent = fileName;
    countEl.textContent = on + " on · " + (vars.length - on) + " off";
    roEl.hidden = !readOnly;
    addBtn.hidden = readOnly;
    maskBtn.setAttribute("aria-pressed", String(hideValues));

    const longest = vars.reduce((n, e) => Math.max(n, e.key.length + (e.exported ? 7 : 0)), 8);
    list.style.setProperty("--key-w", Math.min(longest, MAX_KEY_CH) + "ch");

    const groups = E.sections(doc);
    const byHeading = new Map(groups.sections.map((s) => [s.line, s]));

    const q = filter.trim().toLowerCase();
    const out = [];
    let gap = false;
    // Each group's heading and rows go in one box, so its extent shows.
    const startsGroup = new Map(groups.sections.map((s) => [s.from, s]));
    let box = null;
    let boxEnd = -1;
    doc.entries.forEach((e, i) => {
      if (q) {
        if (e.kind === "var" && matches(e, q)) out.push(row(e));
        return;
      }
      if (box && i >= boxEnd) box = null;
      const group = startsGroup.get(i);
      if (group) {
        box = el("div", "group");
        boxEnd = group.to;
        if (gap) box.classList.add("gap");
        gap = false;
        out.push(box);
      }
      let node = null;
      if (e.kind === "blank") {
        gap = out.length > 0;
        return;
      } else if (e.kind === "var") {
        node = row(e);
      } else if (e.kind === "comment") {
        node = commentEl(e, byHeading);
      } else {
        node = el("div", "other", e.text);
        node.title = "Line " + (e.line + 1) + " is not a variable";
      }
      if (!node) return;
      if (gap) node.classList.add("gap");
      gap = false;
      if (box) box.append(node);
      else out.push(node);
    });

    if (!out.length) {
      out.push(
        el(
          "div",
          "empty-state",
          q ? "No variables match “" + filter.trim() + "”." : "No variables yet. Use + Add, or type KEY=value in the text editor.",
        ),
      );
    }
    rendering = true;
    try {
      list.replaceChildren(...out);
    } finally {
      rendering = false;
    }

    if (!adder.hidden) {
      refreshGroups();
      updateHint();
    }

    if (editing) {
      const ed = list.querySelector(".val-edit");
      if (ed) {
        ed.focus({ preventScroll: true });
        const sel = editing.sel || [ed.value.length, ed.value.length];
        ed.setSelectionRange(sel[0], sel[1]);
        return;
      }
    }

    if (flashLine >= 0) {
      const added = list.querySelector("input[type='checkbox'][data-line=\"" + flashLine + '"]');
      flashLine = -1;
      if (added) {
        added.closest(".row").scrollIntoView({ block: "nearest" });
        added.focus({ preventScroll: true });
        return;
      }
    }
    if (focusSel) {
      const target = list.querySelector(focusSel);
      if (target) target.focus({ preventScroll: true });
    }
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(render);
  }

  function showBanner(text) {
    banner.textContent = text;
    banner.hidden = false;
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => (banner.hidden = true), 6000);
  }

  // Document ----------------------------------------------------------------

  function setDocument(text, v) {
    doc = E.parse(text);
    version = v;
  }

  async function reload() {
    const d = await bridge.document.get();
    readOnly = !!d.readOnly;
    if (d.name) fileName = d.name;
    setDocument(d.text, d.version);
  }

  /**
   * Applies the edits `makeEdits` computes from the current text, one change
   * at a time so quick clicks don't race each other; `done` runs after it
   * lands.
   */
  function change(makeEdits, done) {
    queue = queue.then(async () => {
      if (readOnly) return;
      let edits;
      try {
        edits = makeEdits();
      } catch (err) {
        // Nothing is written: say why.
        showBanner(err && err.message ? err.message : String(err));
        return;
      }
      if (!edits.length) return;
      try {
        const result = await bridge.document.edit(version, edits);
        setDocument(E.applyEdits(doc.text, edits), result && typeof result.version === "number" ? result.version : version + 1);
        if (done) done();
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        try {
          await reload();
        } catch (_) {
          /* keep what we have */
        }
        showBanner(/stale/i.test(message) ? "The file changed at the same moment. Try again." : "Could not change the file: " + message);
      }
    });
    queue.then(render, render);
  }

  /** The lines of the checkboxes shown from line `a` to line `b`, or null if either isn't shown. */
  function linesBetween(a, b) {
    const lines = Array.from(list.querySelectorAll(".row input[type='checkbox']"), (box) => Number(box.dataset.line));
    const i = lines.indexOf(a);
    const j = lines.indexOf(b);
    if (i < 0 || j < 0) return null;
    return lines.slice(Math.min(i, j), Math.max(i, j) + 1);
  }

  // Editing values ----------------------------------------------------------

  function startEdit(line) {
    const e = doc.entries.find((x) => x.kind === "var" && x.line === line);
    if (!e || readOnly || hideValues) return;
    editing = { line, key: e.key, draft: e.value, multiline: e.value.includes("\n"), sel: [0, e.value.length] };
    render();
  }

  /**
   * Saves the draft as one undoable change (nothing when it didn't change).
   * A value that can't be written as typed is never written: on Enter the
   * editor stays open and says so; on leaving it, the edit is dropped and the
   * banner says why.
   */
  function commitEdit(leaving) {
    if (!editing) return;
    const { line, key, draft } = editing;
    if (!E.canWrite(draft)) {
      showBanner(E.UNWRITABLE + (leaving ? " The edit was not saved." : ""));
      if (leaving) editing = null;
      else editing.invalid = true;
      render();
      return;
    }
    editing = null;
    change(() => {
      const e = doc.entries.find((x) => x.kind === "var" && x.line === line);
      return e && e.key === key ? E.setValue(doc, line, draft) : [];
    });
  }

  function cancelEdit() {
    if (!editing) return;
    editing = null;
    render();
  }

  // Adding ------------------------------------------------------------------

  /** Fills the group list, keeping the choice (by name) when the file changed under it. */
  function refreshGroups(prefer) {
    const before = groupSel.selectedOptions[0];
    const keepLabel = before ? before.dataset.label : undefined;
    const keepValue = prefer !== undefined ? String(prefer) : groupSel.value;
    const options = [new Option("No group", NO_GROUP)];
    for (const s of E.sections(doc).sections) {
      const o = new Option(s.label, String(s.line));
      o.dataset.label = s.label;
      options.push(o);
    }
    options.push(new Option("New group…", NEW_GROUP));
    groupSel.replaceChildren(...options);
    const byValue = options.find((o) => o.value === keepValue);
    const byLabel = prefer === undefined && keepLabel !== undefined ? options.find((o) => o.dataset.label === keepLabel) : null;
    groupSel.value = (byLabel || byValue || options[0]).value;
    newGroupIn.hidden = groupSel.value !== NEW_GROUP;
  }

  function setHint(text, error) {
    hint.textContent = text;
    hint.classList.toggle("error", !!error);
  }

  /** What adding this would mean: a bad name or value, or a key that is already there. */
  function updateHint() {
    const key = keyIn.value.trim();
    keyIn.classList.remove("invalid");
    valIn.classList.toggle("invalid", !E.canWrite(valIn.value));
    if (key && !E.isKey(key)) {
      keyIn.classList.add("invalid");
      return setHint("Use letters, digits, _ . and -, not starting with a digit.", true);
    }
    if (!E.canWrite(valIn.value)) return setHint(E.UNWRITABLE, true);
    if (!key) return setHint("");
    const same = doc.entries.filter((e) => e.kind === "var" && e.key === key);
    const onAt = same.find((e) => e.enabled);
    if (!onTouched) onBox.checked = !onAt;
    if (onAt) setHint(key + " is already on at line " + (onAt.line + 1) + ". This one is added switched off; use Only this to swap.");
    else if (same.length) setHint(key + " is also on line " + same.map((e) => e.line + 1).join(", ") + ", switched off.");
    else setHint("");
  }

  function openAdder(section) {
    if (readOnly) return;
    keyIn.value = "";
    valIn.value = "";
    newGroupIn.value = "";
    onTouched = false;
    onBox.checked = true;
    setHint("");
    keyIn.classList.remove("invalid");
    refreshGroups(section == null ? NO_GROUP : section);
    adder.hidden = false;
    keyIn.focus();
  }

  function closeAdder() {
    adder.hidden = true;
    addBtn.focus();
  }

  function submitAdd() {
    const key = keyIn.value.trim();
    if (!E.isKey(key)) {
      keyIn.classList.add("invalid");
      setHint(key ? "Use letters, digits, _ . and -, not starting with a digit." : "Give the variable a name.", true);
      keyIn.focus();
      return;
    }
    if (!E.canWrite(valIn.value)) {
      valIn.classList.add("invalid");
      setHint(E.UNWRITABLE, true);
      valIn.focus();
      return;
    }
    const choice = groupSel.value;
    const newSection = choice === NEW_GROUP ? newGroupIn.value.trim() : "";
    if (choice === NEW_GROUP && !newSection) {
      setHint("Give the new group a name.", true);
      newGroupIn.focus();
      return;
    }
    const opts = {
      key,
      value: valIn.value,
      on: onBox.checked,
      section: choice === NO_GROUP || choice === NEW_GROUP ? null : Number(choice),
      newSection,
    };
    let added = -1;
    change(
      () => {
        const r = E.addVariable(doc, opts);
        added = r.line;
        return r.edits;
      },
      () => {
        flashLine = added;
      },
    );
    // The new row should be visible.
    if (filter) {
      filter = "";
      search.value = "";
    }
    adder.hidden = true;
  }

  // Events ------------------------------------------------------------------

  list.addEventListener("change", (ev) => {
    const box = ev.target;
    if (!(box instanceof HTMLInputElement) || box.type !== "checkbox") return;
    const on = box.checked;

    if (box.dataset.group !== undefined) {
      const heading = Number(box.dataset.group);
      change(() => {
        const s = E.sections(doc).sections.find((x) => x.line === heading);
        return s ? E.setMany(doc, s.vars.map((v) => v.line), on) : [];
      });
      return;
    }

    const line = Number(box.dataset.line);
    const range = rangeFrom !== null ? linesBetween(rangeFrom, line) : null;
    rangeFrom = null;
    lastBoxLine = line;
    if (range) change(() => E.setMany(doc, range, on));
    else change(() => E.toggle(doc, line, on));
  });

  list.addEventListener("click", (ev) => {
    const t = ev.target instanceof Element ? ev.target : null;
    if (!t) return;
    const only = t.closest("button.only");
    if (only) {
      ev.preventDefault();
      const line = Number(only.dataset.line);
      change(() => E.onlyThis(doc, line));
      return;
    }
    const valBtn = t.closest("button.val");
    if (valBtn) {
      ev.preventDefault();
      startEdit(Number(valBtn.dataset.line));
      return;
    }
    const addHere = t.closest("button.add-here");
    if (addHere) {
      ev.preventDefault();
      openAdder(Number(addHere.dataset.group));
      return;
    }
    // Shift-click on a variable's checkbox: the change switches the range from the last one clicked.
    if (t instanceof HTMLInputElement && t.type === "checkbox" && t.dataset.line !== undefined) {
      const line = Number(t.dataset.line);
      rangeFrom = ev.shiftKey && lastBoxLine !== null && lastBoxLine !== line ? lastBoxLine : null;
    }
  });

  // Shift-click shouldn't select text across rows.
  list.addEventListener("mousedown", (ev) => {
    if (ev.shiftKey && ev.target instanceof Element && ev.target.closest(".row") && !ev.target.closest(".val-edit")) ev.preventDefault();
  });

  // The value editor: the draft follows typing; Enter (⌘/Ctrl+Enter in a
  // multi-line box) saves, Escape cancels, leaving it saves.
  list.addEventListener("input", (ev) => {
    if (!editing || !(ev.target instanceof Element) || !ev.target.classList.contains("val-edit")) return;
    editing.draft = ev.target.value;
    if (editing.invalid) {
      editing.invalid = false;
      ev.target.classList.remove("invalid");
      ev.target.removeAttribute("aria-invalid");
    }
  });
  list.addEventListener("focusout", (ev) => {
    const t = ev.target;
    if (rendering || !(t instanceof Element) || !t.classList.contains("val-edit") || !t.isConnected) return;
    commitEdit(true);
  });

  // Up and Down move between checkboxes.
  list.addEventListener("keydown", (ev) => {
    if (ev.target instanceof Element && ev.target.classList.contains("val-edit")) {
      if (ev.isComposing) return;
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        cancelEdit();
      } else if (ev.key === "Enter" && editing && (!editing.multiline || ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        commitEdit();
      }
      return;
    }
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
    const boxes = Array.from(list.querySelectorAll('input[type="checkbox"]'));
    const at = ev.target instanceof Element ? boxes.indexOf(ev.target.closest(".row, .heading")?.querySelector("input")) : -1;
    const next = boxes[at + (ev.key === "ArrowDown" ? 1 : -1)];
    if (next) {
      ev.preventDefault();
      next.focus();
      next.scrollIntoView({ block: "nearest" });
    }
  });

  search.addEventListener("input", () => {
    filter = search.value;
    render();
  });
  search.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && search.value) {
      ev.stopPropagation();
      search.value = "";
      filter = "";
      render();
    }
  });

  maskBtn.addEventListener("click", () => {
    hideValues = !hideValues;
    render();
  });

  addBtn.addEventListener("click", () => (adder.hidden ? openAdder(null) : closeAdder()));
  addOk.addEventListener("click", submitAdd);
  addCancel.addEventListener("click", closeAdder);
  keyIn.addEventListener("input", updateHint);
  valIn.addEventListener("input", updateHint);
  onBox.addEventListener("change", () => (onTouched = true));
  groupSel.addEventListener("change", () => {
    newGroupIn.hidden = groupSel.value !== NEW_GROUP;
    if (!newGroupIn.hidden) newGroupIn.focus();
  });
  adder.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      closeAdder();
    } else if (ev.key === "Enter" && ev.target instanceof HTMLInputElement && ev.target.type === "text") {
      ev.preventDefault();
      submitAdd();
    }
  });

  // Typing in the text editor, Undo, another window.
  bridge.document.onChange((s) => {
    setDocument(s.text, s.version);
    schedule();
  });

  reload().then(render, (err) => {
    list.replaceChildren(el("div", "empty-state", "Could not read the file: " + (err && err.message ? err.message : String(err))));
  });
})();
