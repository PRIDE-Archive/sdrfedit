# SDRF Editor frontend (Angular), served under /pride/services/sdrf-editor.
#
# Build context is the REPO ROOT so this Dockerfile can reach
# package.json/angular.json/src/ at the top level:
#
#   docker build -f frontend/Dockerfile -t sdrfedit-frontend .
#
# Uses frontend/Dockerfile.dockerignore (a BuildKit-specific ignorefile,
# supported by `docker build`/buildx since it's the default builder) instead
# of the root .dockerignore, which is scoped to the backend image and
# excludes the very files (src/, angular.json, package.json) this build needs.
#
# The app is built with --base-href baked in rather than relying on an
# ingress path-rewrite: Angular's client-side router ties routing to
# <base href>, so once the JS loads it needs to agree with the real browser
# URL under /pride/services/sdrf-editor/, not think it's serving from /.

FROM node:20-alpine AS build
WORKDIR /app

COPY package.json ./
RUN npm install

COPY angular.json tsconfig.json tsconfig.app.json ./
COPY src ./src

RUN npx ng build sdrf-editor --configuration=production \
    --base-href /pride/services/sdrf-editor/

# nginx-unprivileged: listens on 8080 and runs as a non-root user out of the
# box, matching the runAsNonRoot/runAsUser:1000 securityContext in k8s/deployment.yaml.
FROM nginxinc/nginx-unprivileged:1.27-alpine

COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/sdrf-editor/browser /usr/share/nginx/html/pride/services/sdrf-editor

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:8080/pride/services/sdrf-editor/ >/dev/null || exit 1
