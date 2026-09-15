# Kubernetes deployment (hh-11)

An **additional** deployment path for the SDRF Editor frontend, alongside the
existing GitHub Pages (`.github/workflows/deploy-pages.yml`) and SSH-to-server
(`deploy-frontend.yml`) deployments -- this does not replace either.

Layout follows `pride-archive-api`'s `.gitlab-ci.yml` / `.kubernetes.yml`
convention: one envsubst-templated manifest per app (`kubernetes.yml`),
namespace and imagePullSecret created imperatively by the pipeline rather
than from committed YAML.

Primary path: GitLab CI (`../../.gitlab-ci.yml`), which on the `pride-deploy`
branch builds the image, pushes it to this project's GitLab Container
Registry, and deploys it -- `deploy_frontend_hh11` job, run manually from the
GitLab pipeline UI. `deploy.sh` below is the fallback for an ad-hoc deploy
from a laptop. Served at `https://www.ebi.ac.uk/pride/services/sdrf-editor/`.

`kubernetes.yml` is a template combining the Deployment and Service in one
file: `image:` and `imagePullSecrets[0].name` are `$FRONTEND_IMAGE` /
`$DOCKER_PULL_SECRET` placeholders, substituted by `envsubst` (CI does this
itself; `deploy.sh deploy` does it for you if both env vars are set). Neither
resource carries a `metadata.namespace` field -- the namespace comes from
`kubectl -n sdrf-editor apply -f ...`, matching `pride-archive-api`. The
registry is private, so `$DOCKER_PULL_SECRET` must exist in the
`sdrf-editor` namespace before applying (CI creates it from the project's
`gitlab-deploy-token` deploy token each run; for a manual deploy, create it
once yourself:
`kubectl -n sdrf-editor create secret docker-registry <name> --docker-server=<registry> --docker-username=... --docker-password=...`).
See `../../backend/k8s/README.md` for the full GitLab CI/CD variables list
(`KUBE_CONFIG`, `CI_DEPLOY_USER`/`CI_DEPLOY_PASSWORD`) -- shared across both
deploy jobs.

`ingress-pride-services.yaml` is **not** part of the pipeline -- applied
manually, once: `kubectl -n sdrf-editor apply -f ingress-pride-services.yaml`.
Re-run that only if the file itself changes.

## Why this build is different from the others

Angular's client-side router is tied to `<base href>`, so a build meant to be
served under a sub-path has to know that sub-path at build time -- unlike the
backend, an ingress path-rewrite can't paper over this after the fact once
the JS has loaded. `frontend/Dockerfile` builds with
`--base-href /pride/services/sdrf-editor/` baked in, and the ingress here
(`ingress-pride-services.yaml`) forwards the path **unchanged** (no
rewrite-target), matching `frontend/nginx.conf`'s layout.

## Before first manual deploy

If the namespace/ingress don't exist yet:
`kubectl create namespace sdrf-editor && kubectl -n sdrf-editor apply -f ingress-pride-services.yaml`.

## Deploy

```bash
export KUBECONFIG=~/.kube/config_hh11
export FRONTEND_IMAGE=<registry>/sdrfedit/frontend:<tag>
export DOCKER_PULL_SECRET=sdrfedit-gitlab-docker-secret
./deploy.sh deploy
./deploy.sh status
```

Verify:

```bash
curl -I https://www.ebi.ac.uk/pride/services/sdrf-editor/
```

## Day to day

```bash
./deploy.sh rollout   # new image pushed, no config change -- restart to pick it up
./deploy.sh logs
./deploy.sh status
```

Every deploy (CI or manual) pins `image:` to a commit-SHA tag, never
`:latest` -- see the comment in `kubernetes.yml` for why (a later rebuild,
even an unrelated one, would otherwise silently move what a shared tag
points to).
