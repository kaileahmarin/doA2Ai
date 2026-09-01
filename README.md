# doA2Ai

**Human-authorized execution for WebMCP**

doA2Ai is a local browser prototype for a simple boundary: agents can prepare a proposed action, while a person reviews and authorizes the exact state before the local simulator proceeds.

It is a demonstration, not a production authorization service. The project has no authentication, backend, durable storage, external account connection, or real-world executor.

## What it demonstrates

- a bounded task with a state-dependent tool surface;
- a human review step that removes agent-callable mutation tools;
- exact-state comparison before the simulated local result; and
- locally generated receipts with redaction of protected human-only fields.

The optional Chrome extension is intentionally read-only: it reports capabilities exposed by the current page and does not approve, fill forms, or execute page actions.

## Run locally

Requirements: Node.js 22 or newer. There are no third-party runtime dependencies.

```powershell
npm.cmd run dev
```

Open [http://127.0.0.1:4173/](http://127.0.0.1:4173/) while the server is running. The [beginner walkthrough](docs/BEGINNER_WALKTHROUGH.md) has step-by-step setup and demo instructions.

To use the optional extension, open `chrome://extensions`, enable Developer mode, and load the [`extension/`](extension/) directory as an unpacked extension.

## Checks

```powershell
npm.cmd run check
```

This exercises the local simulator, source-boundary checks, and static references. It does not establish real-browser WebMCP interoperability, human usability, deployment behavior, authentication, or external execution.

## Repository map

| Path | Purpose |
| --- | --- |
| [`app/`](app/) | Local research-brief fixture, authority-state model, receipt handling, and WebMCP bridge |
| [`extension/`](extension/) | Optional read-only current-page capability extension |
| [`runtime/t1/`](runtime/t1/) | Separate offline synthetic runtime candidate |
| [`tests/`](tests/) | Node test coverage for the local model and interfaces |
| [`docs/`](docs/) | Architecture, UI-boundary, runtime, and beginner documentation |

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [UI boundary](docs/LAUNCHABLE_GUI_UI_TRACK.md)
- [Offline runtime contract](docs/T1_OFFLINE_RUNTIME_CONTRACT.md)
- [Product charter](PRODUCT_CHARTER.md)
- [Project provenance](PROJECT_PROVENANCE.md)
- [Verification scope](VERIFICATION.md)

## License

[MIT](LICENSE)
