const { chromium } = require("playwright-core");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const context = browser.contexts()[0];
  const page = context.pages()[0];
  await page.bringToFront();

  const result = await page.evaluate(async () => {
    const out = {
      pluginLoaded: false,
      provider: null,
      model: null,
      completionReceived: false,
      suggestionPreview: "",
      accepted: false,
      beforeLength: 0,
      afterLength: 0,
      insertedChars: 0,
      error: null,
    };

    try {
      const app = window.app;
      const plugin = app?.plugins?.plugins?.companion;
      if (!plugin) {
        out.error = "companion_plugin_missing";
        return out;
      }
      out.pluginLoaded = true;
      out.provider = plugin.settings?.provider || null;
      out.model = plugin.settings?.model || null;

      plugin.enabled = true;
      const prevStream = plugin.settings.stream;
      plugin.settings.stream = false;

      const welcome = app.vault.getAbstractFileByPath("Welcome.md");
      if (welcome) {
        await app.workspace.getLeaf().openFile(welcome);
      }

      const view = app.workspace.getMostRecentLeaf()?.view;
      const editor = view?.editor;
      if (!editor) {
        plugin.settings.stream = prevStream;
        out.error = "editor_missing";
        return out;
      }

      const seed = [
        "Project kickoff notes:",
        "- ",
      ].join("\n");
      editor.setValue(seed);
      editor.setCursor({ line: 1, ch: 2 });

      const before = editor.getValue();
      out.beforeLength = before.length;

      let suggestionText = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        const gen = plugin.triggerCompletion();
        const first = await Promise.race([
          gen.next(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("completion_timeout")), 40000)
          ),
        ]);
        suggestionText =
          first?.value?.display_suggestion ||
          first?.value?.complete_suggestion ||
          "";
        if (suggestionText && suggestionText.trim().length > 0) {
          out.completionReceived = true;
          break;
        }
      }

      out.suggestionPreview = suggestionText.slice(0, 200);

      if (out.completionReceived) {
        await plugin.acceptCompletion(editor);
      }

      const after = editor.getValue();
      out.afterLength = after.length;
      out.insertedChars = out.afterLength - out.beforeLength;
      out.accepted = out.insertedChars > 0 && after !== before;

      plugin.settings.stream = prevStream;
      return out;
    } catch (e) {
      out.error = String(e);
      return out;
    }
  });

  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})();
