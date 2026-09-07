# Kubernetes deployment (hh-11)

An **additional** deployment path for the SDRF Editor frontend, alongside the
existing GitHub Pages (`.github/workflows/deploy-pages.yml`) and SSH-to-server
(`deploy-frontend.yml`) deployments -- this does not replace either.

Image: `ghcr.io/pride-archive/sdrfedit-frontend`, served at
`https://www.ebi.ac.uk/pride/services/sdrf-editor/`.

## Why this build is different from the others

Angular's client-side router is tied to `<base href>`, so a build meant to be
served under a sub-path has to know that sub-path at build time -- unlike the
backend, an ingress path-rewrite can't paper over this after the fact once
the JS has loaded. `frontend/Dockerfile` builds with
`--base-href /pride/services/sdrf-editor/` baked in, and the ingress here
(`ingress-pride-services.yaml`) forwards the path **unchanged** (no
rewrite-target), matching `frontend/nginx.conf`'s layout.

## Deploy

Build+push happens via GitHub Actions once `.github/workflows/frontend-build-and-push.yml`
is committed and pushed (not done yet as of this writing -- build/test locally
first per the current plan).

To build locally:

```bash
docker build -f frontend/Dockerfile -t sdrfedit-frontend .
docker tag sdrfedit-frontend ghcr.io/pride-archive/sdrfedit-frontend:latest
docker push ghcr.io/pride-archive/sdrfedit-frontend:latest   # needs GHCR push access
```

Then, same as the backend:

```bash
export KUBECONFIG=~/.kube/config_hh11
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

Once a build exists, pin `deployment.yaml`'s `image:` to its commit-SHA tag
rather than leaving it on `:latest` -- see the comment there and
`../../backend/k8s/deployment.yaml` for why (a later rebuild, even an
unrelated one, silently moves what `:latest` points to).
