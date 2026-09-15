#!/bin/bash
# SDRF Editor frontend -- manual Kubernetes deployment (hh-11).
# The GitLab CI pipeline (../../.gitlab-ci.yml, deploy_frontend_hh11) does
# this automatically on pride-deploy; this script is the fallback for an
# ad-hoc deploy from a laptop. kubernetes.yml is a template -- FRONTEND_IMAGE
# and DOCKER_PULL_SECRET must be set (envsubst substitutes them), and
# DOCKER_PULL_SECRET must already exist in the namespace
# (kubectl -n sdrf-editor create secret docker-registry $DOCKER_PULL_SECRET
#  --docker-server=<registry> --docker-username=... --docker-password=...).
#
# This is an ADDITIONAL deployment path alongside the existing GitHub Pages
# and SSH-to-server deployments (see .github/workflows/deploy-pages.yml and
# deploy-frontend.yml) -- it does not replace either of them.

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

NAMESPACE="sdrf-editor"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

check_kubectl() {
    if ! command -v kubectl &> /dev/null; then
        echo -e "${RED}Error: kubectl is not installed${NC}"
        exit 1
    fi
}

check_deploy_vars() {
    if [ -z "${FRONTEND_IMAGE:-}" ] || [ -z "${DOCKER_PULL_SECRET:-}" ]; then
        echo -e "${RED}Error: FRONTEND_IMAGE and DOCKER_PULL_SECRET must be set${NC}"
        echo 'e.g. export FRONTEND_IMAGE=registry.example/sdrfedit/frontend:<tag> DOCKER_PULL_SECRET=sdrfedit-gitlab-docker-secret'
        exit 1
    fi
    if ! command -v envsubst &> /dev/null; then
        echo -e "${RED}Error: envsubst is not installed (gettext package)${NC}"
        exit 1
    fi
}

deploy() {
    echo -e "${GREEN}Deploying SDRF Editor frontend to $(kubectl config current-context)...${NC}"
    kubectl create namespace "$NAMESPACE" || true
    envsubst '$FRONTEND_IMAGE $DOCKER_PULL_SECRET' < "$SCRIPT_DIR/kubernetes.yml" | kubectl -n "$NAMESPACE" apply -f -
    echo -e "${GREEN}Deployment applied${NC}"
}

status() {
    echo -e "${GREEN}Checking deployment status...${NC}"
    kubectl wait --for=condition=ready pod -l app=sdrf-editor -n "$NAMESPACE" --timeout=180s
    kubectl get pods -n "$NAMESPACE"
    kubectl get svc -n "$NAMESPACE"
    kubectl get ingress -n "$NAMESPACE"
}

logs() {
    kubectl logs -f deployment/sdrf-editor -n "$NAMESPACE"
}

rollout() {
    echo -e "${GREEN}Rolling out the latest image...${NC}"
    kubectl rollout restart deployment/sdrf-editor -n "$NAMESPACE"
    kubectl rollout status deployment/sdrf-editor -n "$NAMESPACE" --timeout=300s
}

usage() {
    echo "Usage: $0 [COMMAND]"
    echo ""
    echo "Commands:"
    echo "  deploy    Apply deployment/service (kubernetes.yml)"
    echo "  status    Check deployment status"
    echo "  logs      Follow nginx logs"
    echo "  rollout   Restart the deployment to pick up a new image"
    echo "  help      Show this help message"
}

case "${1:-help}" in
    deploy)  check_kubectl; check_deploy_vars; deploy ;;
    status)  check_kubectl; status ;;
    logs)    check_kubectl; logs ;;
    rollout) check_kubectl; rollout ;;
    help|*)  usage ;;
esac
