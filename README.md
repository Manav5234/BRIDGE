# Bridge

A VS Code extension that connects to a **locally running OpenCode** instance and gives
you the chat in a VS Code view, with the same sessions, models and history the OpenCode
TUI uses.

Bridge does not ship or select a model. It asks the running OpenCode server which model
it is configured to use and displays it. Conversation history is always re-read from
OpenCode, so the transcript in VS Code cannot drift from the real one.

```
You  <->  Bridge (VS Code)  <->  OpenCode server on localhost
```

## Requirements

| Thing | Version used to build and test Bridge |
| --- | --- |
| VS Code | 1.90 or newer (built against 1.141) |
| Node.js | 20 or newer (built with 24) |
| OpenCode | 2.x (tested against 2.0.30) |

## Install and run from source

```bash
npm install
npm run build          # esbuild bundles src/ into dist/extension.js
```

Then open this folder in VS Code and press **F5** ("Run Bridge Extension"). A second
VS Code window opens with Bridge loaded. The `.vscode/launch.json` config builds first
and points at `dist/extension.js`.

For a tighter edit loop, run the bundler in a terminal and reload the dev window with
`Ctrl+R` instead of restarting:

```bash
npm run watch
```

## Use

1. Start OpenCode once. Either run `opencode` in a terminal, or start its background
   service (the same one the TUI uses):

   ```bash
   opencode service start
   ```

2. In VS Code, open the folder you want the agent to work in. Sessions are scoped to
   this directory (first workspace folder, or `bridge.directory` if set).
3. Open the **Bridge** activity-bar icon and send a message.

If OpenCode is not reachable, the chat shows a setup panel with the exact reason
(no server found, nothing listening, credentials rejected, timeout) instead of a
spinner that never ends.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `bridge.serverUrl` | `""` | Connect to a specific OpenCode server. Empty = auto-detect the background service from its state file. |
| `bridge.allowRemoteServer` | `false` | Allow a non-loopback `bridge.serverUrl`. Credentials travel over plain HTTP, so this is off by default. |
| `bridge.username` | `"opencode"` | HTTP Basic auth username. |
| `bridge.password` | `""` | HTTP Basic auth password. Empty = read the password OpenCode writes into its state file. |
| `bridge.directory` | `""` | Directory to scope sessions to. Empty = first workspace folder. |
| `bridge.requestTimeoutMs` | `15000` | Timeout for individual OpenCode requests. |

Changing settings takes effect on the next connect. Bridge logs each connect outcome to
the **Bridge** output channel (View -> Output -> Bridge).

## Tests

```bash
npm run check          # typecheck + lint + unit tests
npm run test           # unit tests only (vitest, hermetic, no network)
npm run smoke          # loads the built bundle and asserts the commands register
node scripts/e2e.mjs   # REAL end-to-end run against your local OpenCode server
```

`scripts/e2e.mjs` is the one that proves the integration: it creates a session, sends a
prompt, waits for streamed text, verifies the stored messages, then deletes the session.
It needs a running OpenCode server and is deliberately not part of `npm run check`.

## Package a VSIX (local use only)

```bash
npm run package        # production bundle + vsce package --no-dependencies
npx @vscode/vsce ls    # list what would be shipped
```

Install the result in your own VS Code:

```bash
code --install-extension bridge-0.1.0.vsix
```

Do not publish Bridge to the Marketplace without the owner's approval; it targets one
machine's local OpenCode install.

## Docs

`ARCHITECTURE.md` in the repository root covers module responsibilities, the message
protocol, the security model, and the implemented / not implemented / limitation list.

## License

MIT.
