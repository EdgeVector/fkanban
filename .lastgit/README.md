# LastGit home - fkanban (GitHub = public mirror)

| Role | Location |
|------|----------|
| SoT / CR / CI / merge | `lastdb:///fkanban` |
| Public mirror | `https://github.com/EdgeVector/fkanban` (read-only for merge) |

## Workflow

1. Agents open CRs with `lastgit cr` (venue = `lastgit`).
2. LastGit runs `.lastgit/ci.sh` -> `ci-required` -> auto-merge.
3. Mirror job pushes LastGit `main` -> GitHub `main` (see `sync-github-mirror.sh`).

GitHub Actions are inert. Do not merge on GitHub.

## Pin

```bash
export LASTGIT_SOCKET=$HOME/.lastdb/data/folddb.sock
export LASTGIT_SCHEMA_MAP=$HOME/.lastgit/schema-map.json
```

The public package/CLI names remain `kanban` and `fkanban`; the git slug is
`fkanban`.
