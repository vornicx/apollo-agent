# Apollo Desktop

Apollo Desktop is deliberately a thin native controller. Its build stages an autonomous Apollo
bundle and the current Node runtime, starts that embedded runtime, and renders the local mission
center in a Tauri webview. Mission state, provider
execution, permissions, traces, memory provenance, and evidence remain owned by Apollo Runtime.

Development prerequisites: Node 22, Rust, and WebKitGTK 4.1. A global `apollo` command is not required.

```bash
npm run apollo -- dashboard       # runtime surface only
npm run check -w @archic/apollo-desktop
npm run dev -w @archic/apollo-desktop
npm run build:desktop
```

The webview is restricted to `http://127.0.0.1:4317`; external navigation is not part of the shell.
Runtime state is stored in Tauri's per-user application-data directory. See `docs/RELEASING.md` for
the release flow.
