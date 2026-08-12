# Deployment and release

## GitHub Pages

Pushing a commit to `master` or `stable` runs `.github/workflows/pages.yml`. The workflow checks out,
verifies, and builds both branches, then deploys them together:

| URL | Branch | Purpose |
| --- | --- | --- |
| `https://shioyadan.github.io/Konata/` | `master` | Unstable development version |
| `https://shioyadan.github.io/Konata/stable/` | `stable` | Latest released version |

Both versions are included in one artifact because each GitHub Pages deployment replaces the whole
site. The `stable` branch should only move to a tested release commit.

In the repository settings, configure Pages to use GitHub Actions. The `github-pages` environment
must also allow deployments from both `master` and `stable`.

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
into `master`. Verify the unstable deployment, then fast-forward `stable` to the release commit:

```bash
git fetch origin
git switch stable
git pull --ff-only origin stable
git merge --ff-only master
git push origin stable
git switch master
```

After verifying the stable deployment, create and push a matching annotated tag:

```bash
git tag -a v1.0.0 -m "Konata v1.0.0"
git push origin v1.0.0
```

The release workflow verifies that the tag matches `package.json` and that the tagged commit is
reachable from both `master` and `stable`. It then runs `make release-archive` and attaches the ZIP
to a GitHub Release. The workflow declares `contents: write` permission for its `GITHUB_TOKEN` in
`.github/workflows/release.yml`.
