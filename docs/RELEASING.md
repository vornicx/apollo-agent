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
5. GitHub Actions builds and validates the Linux packages, creates build-provenance attestations,
   and attaches the installers plus `SHA256SUMS` to a prerelease.

The release job sets `APPIMAGE_EXTRACT_AND_RUN=1`, so its packaging tools also work on runners
where FUSE is unavailable. CI runs only for branches and pull requests; the release workflow owns
tag verification to avoid compiling the same tagged tree twice.

No tag is created automatically by the repository scripts. Publishing remains an explicit human-authorized action.
