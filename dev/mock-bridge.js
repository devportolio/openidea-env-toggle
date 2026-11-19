/*
 * A stand-in for OpenIDEA's frame bridge (`window.openidea`) for the dev
 * pages: a document held in memory, edits checked like the IDE checks them,
 * and theme variables like the ones the IDE sets on the page's root.
 * Not part of the package: only web/ is shipped.
 */
(function () {
  "use strict";

  const LIGHT = {
    "--openidea-bg": "#ffffff",
    "--openidea-bg-elevated": "#f7f8fa",
    "--openidea-bg-hover": "#eef0f3",
    "--openidea-bg-input": "#ffffff",
    "--openidea-bg-selected": "#d5e1ff",
    "--openidea-fg": "#1e1f22",
    "--openidea-fg-strong": "#000000",
    "--openidea-fg-muted": "#6c707e",
    "--openidea-border": "#dfe1e5",
    "--openidea-focus-ring": "#3574f0",
    "--openidea-accent": "#3574f0",
    "--openidea-fg-on-accent": "#ffffff",
    "--openidea-warning": "#c27d04",
    "--openidea-danger": "#e55765",
  };
  const DARK = {
    "--openidea-bg": "#1e1f22",
    "--openidea-bg-elevated": "#2b2d30",
    "--openidea-bg-hover": "#393b40",
    "--openidea-bg-input": "#1e1f22",
    "--openidea-bg-selected": "#2e436e",
    "--openidea-fg": "#dfe1e5",
    "--openidea-fg-strong": "#ffffff",
    "--openidea-fg-muted": "#868a91",
    "--openidea-border": "#393b40",
    "--openidea-focus-ring": "#3574f0",
    "--openidea-accent": "#3574f0",
    "--openidea-fg-on-accent": "#ffffff",
    "--openidea-warning": "#d6ae58",
    "--openidea-danger": "#f75464",
  };

  /**
   * Installs `window.openidea` over `text` and returns a handle: `text`,
   * `type(next)` (a change made in the text editor), `onEdit` (called after
   * the page edits), `dark` and `setDark(dark)`.
   */
  function install(opts) {
    let text = (opts && opts.text) || "";
    const name = (opts && opts.name) || ".env";
    let version = 1;
    let theme = null;
    const listeners = [];
    const themeListeners = [];

    function applyTheme(dark) {
      theme = { dark: !!dark, vars: dark ? DARK : LIGHT };
      for (const [k, v] of Object.entries(theme.vars)) document.documentElement.style.setProperty(k, v);
      document.documentElement.dataset.theme = theme.dark ? "dark" : "light";
      themeListeners.forEach((fn) => fn(theme));
    }

    const handle = {
      get text() {
        return text;
      },
      get dark() {
        return theme.dark;
      },
      setDark: applyTheme,
      type(next) {
        text = next;
        version++;
        listeners.forEach((fn) => fn({ version, text }));
      },
      onEdit: null,
    };

    function changed() {
      version++;
      if (handle.onEdit) handle.onEdit(text);
      return { version };
    }

    window.openidea = {
      postMessage() {},
      onMessage() {},
      get theme() {
        return theme;
      },
      onThemeChange(fn) {
        themeListeners.push(fn);
      },
      document: {
        async get() {
          return { version, text, readOnly: false, name };
        },
        onChange(fn) {
          listeners.push(fn);
        },
        async edit(v, edits) {
          if (v !== version) throw new Error("stale");
          let at = 0;
          for (const e of edits) {
            if (e.from < at || e.to < e.from || e.to > text.length) throw new Error("edits must be sorted, in range and not overlap");
            at = e.to;
          }
          for (const e of [...edits].reverse()) text = text.slice(0, e.from) + e.insert + text.slice(e.to);
          return changed();
        },
        async replace(v, next) {
          if (v !== version) throw new Error("stale");
          text = next;
          return changed();
        },
      },
      saveFile: async () => null,
      openFile: async () => null,
    };

    applyTheme(opts && opts.dark);
    return handle;
  }

  window.MockBridge = { install, LIGHT, DARK };
})();
