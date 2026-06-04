/**
 * Gateway UI bridge for headless Pi SDK sessions.
 *
 * Pi SDK ships an `ExtensionUIContext` that's normally backed by a terminal
 * TUI (input/select/confirm pop up real dialogs). When we run the SDK as a
 * library inside a server, there's no terminal — so by default Pi SDK uses a
 * no-op UI and `ctx.hasUI === false`. New-style PI agents (post AB-566/570)
 * bundle their own `ask_user` extension that calls `ctx.ui.input()` directly,
 * which short-circuits to "no UI available" in our context.
 *
 * This bridge fixes that by providing an `ExtensionUIContext` whose dialog
 * methods (`input`, `select`, `confirm`, `editor`) emit gateway SSE events
 * (`ask_user_start` / `ask_user_end`) and await the answer via the existing
 * `awaitResolver` plumbing in session/registry.ts. All TUI-only methods
 * (themes, widgets, status bar, terminal input) are no-op stubs.
 *
 * Wire it in `session.ts` via `session.extensionRunner.setUIContext(...)`
 * AFTER `createAgentSession()` returns. Once set, `runner.hasUI()` flips to
 * true and the bundled `ask_user` flows through gateway events end-to-end.
 */

import type {
  ExtensionUIContext,
  ExtensionUIDialogOptions,
} from "@mariozechner/pi-coding-agent";

import { awaitResolver } from "@/session/registry";
import type { SessionEventEmitter } from "@/session/session";

interface AnswerPayload {
  answer?: string;
  selected?: string;
}

const newAskId = () => crypto.randomUUID();

const isYes = (text: string | undefined): boolean => {
  if (!text) return false;
  const v = text.trim().toLowerCase();
  return v === "yes" || v === "y" || v === "true" || v === "1" || v === "approve" || v === "confirm" || v === "ok";
};

/**
 * Race the resolver against an optional AbortSignal so that aborting the
 * agent run cleanly cancels any pending UI prompt instead of hanging
 * forever.
 */
function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | undefined> {
  if (!signal) return promise.then((v) => v as T | undefined);
  return new Promise<T | undefined>((resolve, reject) => {
    let done = false;
    const onAbort = () => {
      if (done) return;
      done = true;
      resolve(undefined); // cancelled prompts return undefined per Pi SDK contract
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise
      .then((v) => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", onAbort);
        resolve(v as T | undefined);
      })
      .catch((err) => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", onAbort);
        reject(err);
      });
  });
}

export function createGatewayUIContext(opts: {
  conversationId: string;
  emitter: SessionEventEmitter;
}): ExtensionUIContext {
  const { conversationId, emitter } = opts;

  const askForAnswer = async (
    question: string,
    options: string[],
    dialogOpts: ExtensionUIDialogOptions | undefined,
  ): Promise<AnswerPayload | undefined> => {
    const askId = newAskId();
    emitter.emit("ask_user_start", {
      askId,
      question,
      options,
      conversationId,
    });
    try {
      const answer = await withAbort(
        awaitResolver<AnswerPayload>(conversationId, askId),
        dialogOpts?.signal,
      );
      emitter.emit("ask_user_end", {
        askId,
        conversationId,
        answer: answer?.answer,
        selected: answer?.selected,
        cancelled: answer === undefined,
      });
      return answer;
    } catch (err) {
      emitter.emit("ask_user_end", {
        askId,
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };

  return {
    // ── The four methods the bundled ask_user / extension authors actually call.
    async input(title, _placeholder, opts) {
      const answer = await askForAnswer(title, [], opts);
      return answer?.answer;
    },

    async select(title, options, opts) {
      const answer = await askForAnswer(title, options, opts);
      // Prefer the explicitly-selected option title; fall back to the freeform answer.
      return answer?.selected ?? answer?.answer;
    },

    async confirm(title, message, opts) {
      const combined = message ? `${title}\n\n${message}` : title;
      const answer = await askForAnswer(combined, ["Yes", "No"], opts);
      const value = answer?.selected ?? answer?.answer;
      return isYes(value);
    },

    async editor(title: string, prefill?: string) {
      // Same as input for our purposes — multi-line vs single-line is a TUI distinction.
      const answer = await askForAnswer(title, [], undefined);
      return answer?.answer ?? prefill;
    },

    // ── Non-blocking notify: surface as an event the FE can choose to render.
    notify(message, type) {
      emitter.emit("ui_notify", { message, level: type ?? "info", conversationId });
    },

    // ── TUI-only methods: no-op stubs. The bundle never relies on these for
    //    answering the LLM; they're cosmetic terminal features.
    onTerminalInput() {
      return () => {};
    },
    setStatus() {},
    setWorkingMessage() {},
    setWorkingVisible() {},
    setWorkingIndicator() {},
    setHiddenThinkingLabel() {},
    setWidget() {},
    setFooter() {},
    setHeader() {},
    setTitle() {},
    pasteToEditor() {},
    setEditorText() {},
    getEditorText() {
      return "";
    },
    addAutocompleteProvider() {},
    setEditorComponent() {},
    getEditorComponent() {
      return undefined;
    },
    getAllThemes() {
      return [];
    },
    getTheme() {
      return undefined;
    },
    setTheme() {
      return { success: true };
    },
    getToolsExpanded() {
      return false;
    },
    setToolsExpanded() {},

    // `custom` is for full-screen TUI overlays — never invoked in headless mode.
    // Return a never-resolving promise to keep the contract; callers that actually
    // need it must run in interactive TUI mode.
    custom<T>() {
      return new Promise<T>(() => {});
    },

    // `theme` is read-only — extensions only consult it for styling. Stub minimal.
    theme: {} as unknown as ExtensionUIContext["theme"],
  };
}
