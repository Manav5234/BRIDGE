// Load the built bundle with a stubbed `vscode` module and run activate().
// This checks the real esbuild output, not the TypeScript sources.
import Module from "node:module";
import { pathToFileURL } from "node:url";

const commands = new Map();
const subscriptions = [];
const logged = [];

const vscodeStub = {
  commands: {
    registerCommand: (name, handler) => {
      commands.set(name, handler);
      return { dispose() {} };
    },
    executeCommand: async () => undefined,
  },
  window: {
    createOutputChannel: () => ({
      appendLine: (line) => logged.push(line),
      dispose() {},
    }),
    registerWebviewViewProvider: () => ({ dispose() {} }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
  },
  workspace: {
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  Uri: { joinPath: (base, ...parts) => ({ toString: () => [base, ...parts].join("/") }) },
  ExtensionContext: class {},
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

const mod = await import(pathToFileURL("./dist/extension.js").href);
console.log("exported keys:", Object.keys(mod));
console.log("has activate:", typeof mod.activate, "has deactivate:", typeof mod.deactivate);

mod.activate({ subscriptions, extensionUri: { toString: () => "file:///bridge" } });

console.log("registered commands:", [...commands.keys()].sort().join(", "));
console.log("logged:", logged);

const expected = [
  "bridge.connect",
  "bridge.disconnect",
  "bridge.newSession",
  "bridge.openChat",
  "bridge.stopGeneration",
];
const missing = expected.filter((name) => !commands.has(name));
console.log(missing.length === 0 ? "OK: all 5 commands registered" : `MISSING: ${missing.join(", ")}`);

mod.deactivate();
process.exit(missing.length === 0 ? 0 : 1);
