# Agent instructions

Pero is in development: until 1.0.0 ships, every change goes out as its own release so the published package stays close to `main`. [Development](./docs/DEVELOPMENT.md) covers building, testing, and releasing.

## Bump the version with every change

Before 1.0.0, every branch you push bumps the version in `package.json` and `package-lock.json`, so its merge to `main` publishes a release:

```sh
npm version patch --no-git-tag-version   # fixes, docs, refactors, dependency updates
npm version minor --no-git-tag-version   # new features and breaking changes
```

- Bump once per branch. Compare with `main` first (`git diff origin/main -- package.json`); if the branch already bumps the version, leave it, unless a later commit needs a minor bump where the branch only has a patch one.
- If `main` moves past the branch's version, merge `main` in and bump again from its version.
- Commit the bump in the same push as the change, with the message `chore: release X.Y.Z`.
- Never bump to 1.0.0 or a major version on your own; that release is the maintainers' call.
