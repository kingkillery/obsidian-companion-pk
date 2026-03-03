const { chromium } = require("playwright-core");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const context = browser.contexts()[0];
  const page = context.pages()[0];
  await page.bringToFront();

  const result = await page.evaluate(async () => {
    const out = {
      pluginLoaded: false,
      todo: null,
      atOpen: null,
      atLink: null,
      debugEnabled: false,
      completionReceived: false,
      completionPreview: "",
      payloadCaptured: false,
      payloadHasCurrentFilePath: false,
      payloadHasBeforeCursorBlock: false,
      payloadHasUnrenderedTemplateMarkers: false,
      userMessageHasPathValue: false,
      userMessageHasCursorBlocks: false,
      completionResult: null,
      slashCommandResult: null,
      atOpenExecWorked: false,
      atLinkExecWorked: false,
      atOpenExecResult: null,
      atLinkExecResult: null,
    };

    const app = window.app;
    const plugin = app?.plugins?.plugins?.companion;
    if (!plugin) {
      out.error = "companion_plugin_missing";
      return out;
    }
    out.pluginLoaded = true;
    plugin.enabled = true;

    let view = app.workspace.getMostRecentLeaf()?.view;
    if (!view?.editor) {
      out.error = "active_editor_missing";
      return out;
    }
    try {
      const welcome = app.vault.getAbstractFileByPath("Welcome.md");
      if (welcome) {
        await app.workspace.getLeaf().openFile(welcome);
      }
    } catch (e) {
      out.openFileError = String(e);
    }
    view = app.workspace.getMostRecentLeaf()?.view || view;
    const editor = view.editor;

    const runSlash = async (input) => {
      editor.setValue(input);
      editor.setCursor({ line: 0, ch: input.length });
      const ctx = plugin.extractSlashContext(editor, view);
      if (!ctx) {
        return { ctx: false, trigger: null, query: "", count: 0, top: [] };
      }
      const suggestions = await plugin.slash_command_service.get_suggestions(
        ctx.query,
        ctx,
        ctx.command_trigger
      );
      return {
        ctx: true,
        trigger: ctx.command_trigger,
        query: ctx.query,
        count: suggestions.length,
        top: suggestions.slice(0, 5).map((s) => ({ id: s.id, title: s.title })),
      };
    };

    out.todo = await runSlash("/todo");
    out.atOpen = await runSlash("@open ");
    out.atLink = await runSlash("@link ");

    try {
      editor.setValue("@link Welcome");
      editor.setCursor({ line: 0, ch: "@link Welcome".length });
      const linkCtx = plugin.extractSlashContext(editor, view);
      const linkSuggestions = await plugin.slash_command_service.get_suggestions(
        linkCtx.query,
        linkCtx,
        linkCtx.command_trigger
      );
      const firstLink = linkSuggestions.find((s) => s.id.startsWith("link::"));
      if (firstLink) {
        out.atLinkExecResult = await plugin.slash_command_service.execute_command(
          firstLink.id,
          linkCtx
        );
        out.atLinkExecWorked =
          !!out.atLinkExecResult?.success &&
          editor.getValue().includes("[[Welcome");
      }
    } catch (e) {
      out.atLinkExecError = String(e);
    }

    try {
      editor.setValue("@open Welcome");
      editor.setCursor({ line: 0, ch: "@open Welcome".length });
      const openCtx = plugin.extractSlashContext(editor, view);
      const openSuggestions = await plugin.slash_command_service.get_suggestions(
        openCtx.query,
        openCtx,
        openCtx.command_trigger
      );
      const firstOpen = openSuggestions.find((s) => s.id.startsWith("open::"));
      if (firstOpen) {
        out.atOpenExecResult = await plugin.slash_command_service.execute_command(
          firstOpen.id,
          openCtx
        );
        const activePath = app.workspace.getActiveFile()?.path || "";
        out.atOpenExecWorked = activePath.toLowerCase().includes("welcome.md");
      }
    } catch (e) {
      out.atOpenExecError = String(e);
    }

    try {
      const provider = "openrouter";
      const current = plugin.settings.provider_settings?.[provider] || {
        settings: "{}",
        models: {},
      };
      const parsed = JSON.parse(current.settings || "{}");
      parsed.debug_prompt_payload = true;
      plugin.settings.provider = provider;
      plugin.settings.provider_settings[provider] = {
        settings: JSON.stringify(parsed),
        models: current.models || {},
      };
      await plugin.saveSettings();
      out.debugEnabled = true;
    } catch (e) {
      out.debugEnableError = String(e);
    }

    const text = [
      "This is a context smoke test line one.",
      "Line two has detail about HVAC load calculations.",
      "Line three should help completion around cursor.",
      "End.",
    ].join("\n");
    editor.setValue(text);
    editor.setCursor({ line: 1, ch: 18 });

    try {
      const generator = plugin.triggerCompletion();
      const first = await Promise.race([
        generator.next(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("completion_timeout")), 30000)
        ),
      ]);
      out.completionReceived = !first.done;
      out.completionPreview =
        first?.value?.display_suggestion?.slice?.(0, 160) ||
        first?.value?.complete_suggestion?.slice?.(0, 160) ||
        "";
    } catch (e) {
      out.completionError = String(e);
    }

    const payload = window.__companion_last_openrouter_payload;
    out.payloadCaptured = !!payload;
    if (payload) {
      const payloadText = JSON.stringify(payload);
      out.payloadHasCurrentFilePath = payloadText.includes("current_file_path");
      out.payloadHasBeforeCursorBlock = payloadText.includes(
        "up_to_500-1500_chars_before_cursor"
      );
      out.payloadHasUnrenderedTemplateMarkers =
        payloadText.includes("{{current_file_path}}") ||
        payloadText.includes("{{up_to_500-1500_chars_before_cursor}}") ||
        payloadText.includes("{{up_to_200-800_chars_after_cursor}}") ||
        payloadText.includes("{{current_note_title}}");

      try {
        const userMessage =
          payload?.payload?.messages?.find?.((m) => m.role === "user")?.content || "";
        out.userMessageHasPathValue =
          typeof userMessage === "string" &&
          /path:\\s+\\S+/.test(userMessage);
        out.userMessageHasCursorBlocks =
          typeof userMessage === "string" &&
          userMessage.includes("<CONTEXT_AROUND_CURSOR>") &&
          userMessage.includes("<<<CURSOR>>>");
        out.userMessagePreview =
          typeof userMessage === "string"
            ? userMessage.slice(0, 600)
            : String(userMessage).slice(0, 600);
      } catch (e) {
        out.userMessageParseError = String(e);
      }
    }

    out.completionResult = window.__companion_last_completion_result || null;
    out.slashCommandResult = window.__companion_last_slash_command_result || null;

    return out;
  });

  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})();
