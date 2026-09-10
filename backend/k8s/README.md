# Kubernetes deployment (hh-11)

Layout follows `pride-archive-api`'s `.gitlab-ci.yml` / `.kubernetes.yml`
convention: one envsubst-templated manifest per app (`kubernetes.yml`),
namespace and imagePullSecret created imperatively by the pipeline rather
than from committed YAML, secrets from GitLab CI/CD variables instead of a
locally-applied `secret.yaml`.

Primary path: GitLab CI (`../../.gitlab-ci.yml`), which on the `pride-deploy`
branch builds the image, pushes it to this project's GitLab Container
Registry, and deploys it -- `deploy_backend_hh11` job, run manually from the
GitLab pipeline UI. `deploy.sh` below is the fallback for an ad-hoc deploy
from a laptop against whatever cluster your current `kubectl` context points
at.

`kubernetes.yml` is a template combining the ConfigMap, Deployment and
Service in one file: `image:`, `imagePullSecrets[0].name`, and the
ConfigMap's `LLM_BASE_URL`/`EMBEDDING_BASE_URL` are `$BACKEND_IMAGE` /
`$DOCKER_PULL_SECRET` / `$LLM_BASE_URL` / `$EMBEDDING_BASE_URL`
placeholders, substituted by `envsubst` (CI does this itself; `deploy.sh
deploy` does it for you if the env vars are set -- see below). Both
`*_BASE_URL`s are internal hh-44 hostnames -- they're GitLab CI/CD
variables, not committed values, so they never land in the (GitHub-mirrored)
repo. None of its resources carry a
`metadata.namespace` field -- the namespace comes from `kubectl -n
sdrf-assistant apply -f ...`, matching `pride-archive-api`. The registry is
private, so `$DOCKER_PULL_SECRET` must exist in the `sdrf-assistant`
namespace before applying (CI creates it from the project's
`gitlab-deploy-token` deploy token each run; for a manual deploy, create it
once yourself:
`kubectl -n sdrf-assistant create secret docker-registry <name> --docker-server=<registry> --docker-username=... --docker-password=...`).

`ingress-pride-services.yaml` is **not** part of the pipeline -- like
`pride-archive-api`, it's applied manually, once:
`kubectl -n sdrf-assistant apply -f ingress-pride-services.yaml`. Re-run that
only if the file itself changes.

## GitLab CI/CD variables (Settings > CI/CD > Variables)

| Variable | Purpose |
|---|---|
| `KUBE_CONFIG` | base64-encoded kubeconfig for the hh-11 context |
| `LLM_BASE_URL` | internal hh-44 pride-llm-api URL -- baked into `kubernetes.yml`'s ConfigMap by `envsubst` at deploy time, protect (not necessarily secret-worthy, but it's internal network topology, not something to commit) |
| `EMBEDDING_BASE_URL` | same idea, optional -- leave unset while embeddings aren't wired to a real provider (empty is fine, retrieval degrades to lexical-only) |
| `LLM_API_KEY`, `EMBEDDING_API_KEY`, `MINERU_API_KEY` | app secrets, written into the `sdrf-assistant-secrets` k8s Secret at deploy time -- mask and protect these, restrict to the `pride-deploy` branch |
| `CI_DEPLOY_USER` / `CI_DEPLOY_PASSWORD` | auto-populated by GitLab once a deploy token named `gitlab-deploy-token` exists (Settings > Repository > Deploy tokens, `read_registry` scope) |

`secret.yaml` (gitignored, see `secret.example.yaml`) is only for the manual
`deploy.sh` fallback below -- CI never reads it; it creates the
`sdrf-assistant-secrets` k8s Secret directly from the GitLab CI/CD variables
above.

## Before first manual deploy

1. `EMBEDDING_BASE_URL` is optional -- embeddings aren't wired to a real
   provider yet, so it's fine to leave unset (`LLM_AUTH_HEADER`/`LLM_MODEL`
   are already the real pride-llm-api values on hh-44; `LLM_BASE_URL` is a
   variable you must supply -- see below).
2. `cp secret.example.yaml secret.yaml` and fill in any real API keys
   (`secret.yaml` is gitignored -- never commit it).
3. Build/push an image (or use a tag CI already pushed) and export
   `BACKEND_IMAGE`, `DOCKER_PULL_SECRET` and `LLM_BASE_URL` -- see
   `deploy.sh`'s `check_deploy_vars` for the exact form; get the real
   `LLM_BASE_URL` from `DEPLOYMENT_SECRETS.local.md` (gitignored, ask a
   teammate if you don't have it).
4. If the namespace/ingress don't exist yet:
   `kubectl create namespace sdrf-assistant && kubectl -n sdrf-assistant apply -f ingress-pride-services.yaml`.

## Deploy

```bash
export KUBECONFIG=~/.kube/config_hh11   # point at hh-11
export BACKEND_IMAGE=<registry>/sdrfedit/backend:<tag>
export DOCKER_PULL_SECRET=sdrfedit-gitlab-docker-secret
export LLM_BASE_URL=<internal pride-llm-api URL, see DEPLOYMENT_SECRETS.local.md>
./deploy.sh deploy
./deploy.sh status
```

## Day to day

```bash
./deploy.sh rollout   # new image pushed by CI, no config change -- restart to pick it up
./deploy.sh logs      # follow logs
./deploy.sh status    # pods / service / ingress
./deploy.sh delete    # tear down deployment/service/configmap/secret (keeps namespace and ingress)
```

## Updating config or secrets

```bash
export BACKEND_IMAGE=<registry>/sdrfedit/backend:<tag> DOCKER_PULL_SECRET=sdrfedit-gitlab-docker-secret LLM_BASE_URL=<...>
./deploy.sh deploy   # re-applies kubernetes.yml (ConfigMap included) and secret.yaml
kubectl rollout restart deployment/sdrf-assistant -n sdrf-assistant
```

For CI-driven deploys, update the GitLab CI/CD variable instead and re-run
the `deploy_backend_hh11` job -- it recreates `sdrf-assistant-secrets` every
run.
