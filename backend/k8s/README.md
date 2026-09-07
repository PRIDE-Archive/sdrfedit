# Kubernetes deployment (hh-11)

Modeled on `pmultiqc`'s deployment: GitHub Actions builds and pushes the
image to GHCR; Kubernetes deployment is manual, via `deploy.sh` against
whatever cluster your current `kubectl` context points at.

Image: `ghcr.io/pride-archive/sdrfedit-backend:latest` (also tagged with the commit
SHA). Public repo -> public GHCR package by default, so no `imagePullSecrets`
needed unless the package is made private (see `deployment.yaml` for where to
add one if so).

## Before first deploy

1. Confirm the `TODO` values in `configmap.yaml` -- in particular
   `LLM_BASE_URL` / `EMBEDDING_BASE_URL`, which need the real reachable
   address of `pride-llm-api` on the hh-44 cluster (internal DNS if hh-11 and
   hh-44 share a network, otherwise an ingress URL).
2. `cp secret.example.yaml secret.yaml` and fill in any real API keys
   (`secret.yaml` is gitignored -- never commit it).
3. Push to `main` (or wait for the next push touching `backend/**`) so
   GitHub Actions builds and pushes the image -- check the Actions tab.

## Deploy

```bash
export KUBECONFIG=~/.kube/config_hh11   # point at hh-11
./deploy.sh deploy
./deploy.sh status
```

## Day to day

```bash
./deploy.sh rollout   # new image pushed by CI, no config change -- restart to pick it up
./deploy.sh logs      # follow logs
./deploy.sh status    # pods / service / ingress
./deploy.sh delete    # tear down deployment/service/ingress/configmap/secret (keeps the namespace)
```

## Updating config or secrets

```bash
kubectl apply -f configmap.yaml   # or secret.yaml
kubectl rollout restart deployment/sdrf-assistant -n sdrf-assistant
```
