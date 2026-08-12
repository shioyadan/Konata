# Deployment and release

## GitHub Pages

Pushing a commit to `master` runs `.github/workflows/pages.yml`. The workflow installs the exact
dependencies from the lock file with `npm ci`, runs the existing Make verification targets, uploads
`dist-web`, and deploys it to GitHub Pages.

In the repository settings, configure Pages to use GitHub Actions. The `github-pages` environment
must also allow deployments from `master`.

## Release archive

Run the following command from the development container:

```bash
make release-archive
```

This runs the complete verification set and creates a versioned archive. The version comes from
`package.json`:

```text
dist-release/konata-v1.0.0.zip
└── konata-v1.0.0/
    ├── index.html
    ├── README.md
    └── LICENSE.md
```

## Publish a release

Update the version in both `package.json` and `package-lock.json`. Commit the changes and merge them
into `master`. When the release commit is ready, create and push a matching annotated tag:

```bash
git tag -a v1.0.0 -m "Konata v1.0.0"
git push origin v1.0.0
```

The release workflow verifies that the tag matches `package.json` and that the tagged commit is
reachable from `master`. It then runs `make release-archive` and attaches the ZIP to a GitHub
Release. The workflow declares `contents: write` permission for its `GITHUB_TOKEN` in
`.github/workflows/release.yml`.
