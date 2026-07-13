# Releasing Apollo Desktop

Apollo Desktop is a controller for the runtime. The Linux package includes a bundled CommonJS runtime and the exact Node executable used to build it, so users do not need a global `apollo` command.

## Local release check

```bash
npm ci
npm run verify
npm run build:desktop
```

Expected Linux artifacts:

- `packages/desktop/src-tauri/target/release/bundle/deb/*.deb`
- `packages/desktop/src-tauri/target/release/bundle/appimage/*.AppImage`

## Tagged release

1. Update all package, Cargo, and Tauri versions together.
2. Update `CHANGELOG.md` and measured benchmark evidence.
3. Run `npm run verify` and a controlled repeated benchmark.
4. Commit the release, create a tag such as `v0.2.0-alpha.0`, and push the tag.
5. GitHub Actions builds the Linux packages and attaches them to a prerelease.

No tag is created automatically by the repository scripts. Publishing remains an explicit human-authorized action.
