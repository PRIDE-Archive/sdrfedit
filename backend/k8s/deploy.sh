#!/bin/bash
# SDRF Wizard AI Assistant backend -- manual Kubernetes deployment (hh-11).
# The GitLab CI pipeline (../../.gitlab-ci.yml, deploy_backend_hh11) does
# this automatically on pride-deploy; this script is the fallback for an
# ad-hoc deploy from a laptop. kubernetes.yml is a template -- BACKEND_IMAGE,
# DOCKER_PULL_SECRET and LLM_BASE_URL must be set (envsubst substitutes
# them; LLM_BASE_URL is an internal hh-44 hostname, see
# DEPLOYMENT_SECRETS.local.md, never committed). EMBEDDING_BASE_URL is the
# same kind of value but optional -- leave it unset while embeddings aren't
# wired to a real provider. DOCKER_PULL_SECRET must already exist in the
# namespace
# (kubectl -n sdrf-assistant create secret docker-registry $DOCKER_PULL_SECRET
#  --docker-server=<registry> --docker-username=... --docker-password=...).

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

NAMESPACE="sdrf-assistant"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

check_kubectl() {
    if ! command -v kubectl &> /dev/null; then
        echo -e "${RED}Error: kubectl is not installed${NC}"
        exit 1
    fi
}

check_secret_file() {
    if [ ! -f "$SCRIPT_DIR/secret.yaml" ]; then
        echo -e "${RED}Error: $SCRIPT_DIR/secret.yaml not found${NC}"
        echo "Copy secret.example.yaml -> secret.yaml and fill in real API keys first."
        exit 1
    fi
}

check_deploy_vars() {
    if [ -z "${BACKEND_IMAGE:-}" ] || [ -z "${DOCKER_PULL_SECRET:-}" ] || [ -z "${LLM_BASE_URL:-}" ]; then
        echo -e "${RED}Error: BACKEND_IMAGE, DOCKER_PULL_SECRET and LLM_BASE_URL must be set${NC}"
        echo 'e.g. export BACKEND_IMAGE=registry.example/sdrfedit/backend:<tag> DOCKER_PULL_SECRET=sdrfedit-gitlab-docker-secret LLM_BASE_URL=<internal pride-llm-api URL, see DEPLOYMENT_SECRETS.local.md>'
        exit 1
    fi
    if ! command -v envsubst &> /dev/null; then
        echo -e "${RED}Error: envsubst is not installed (gettext package)${NC}"
        exit 1
    fi
}

deploy() {
    echo -e "${GREEN}Deploying SDRF Wizard AI Assistant backend to $(kubectl config current-context)...${NC}"
    kubectl create namespace "$NAMESPACE" || true
    kubectl -n "$NAMESPACE" apply -f "$SCRIPT_DIR/secret.yaml"
    envsubst '$BACKEND_IMAGE $DOCKER_PULL_SECRET $LLM_BASE_URL $EMBEDDING_BASE_URL' < "$SCRIPT_DIR/kubernetes.yml" | kubectl -n "$NAMESPACE" apply -f -
    echo -e "${GREEN}Deployment applied${NC}"
}

status() {
    echo -e "${GREEN}Checking deployment status...${NC}"
    kubectl wait --for=condition=ready pod -l app=sdrf-assistant -n "$NAMESPACE" --timeout=300s
    kubectl get pods -n "$NAMESPACE"
    kubectl get svc -n "$NAMESPACE"
    kubectl get ingress -n "$NAMESPACE"
}

logs() {
    kubectl logs -f deployment/sdrf-assistant -n "$NAMESPACE"
}

rollout() {
    echo -e "${GREEN}Rolling out the latest image...${NC}"
    kubectl rollout restart deployment/sdrf-assistant -n "$NAMESPACE"
    kubectl rollout status deployment/sdrf-assistant -n "$NAMESPACE" --timeout=600s
}

delete() {
    echo -e "${YELLOW}Deleting sdrf-assistant...${NC}"
    envsubst '$BACKEND_IMAGE $DOCKER_PULL_SECRET $LLM_BASE_URL $EMBEDDING_BASE_URL' < "$SCRIPT_DIR/kubernetes.yml" | kubectl -n "$NAMESPACE" delete -f - --ignore-not-found
    kubectl -n "$NAMESPACE" delete -f "$SCRIPT_DIR/secret.yaml" --ignore-not-found
    echo -e "${GREEN}Deletion completed (namespace and ingress left in place; delete them yourself if you want them gone too)${NC}"
}

usage() {
    echo "Usage: $0 [COMMAND]"
    echo ""
    echo "Commands:"
    echo "  deploy    Apply secret, configmap/deployment/service (kubernetes.yml)"
    echo "  status    Check deployment status"
    echo "  logs      Follow application logs"
    echo "  rollout   Restart the deployment to pick up a new image (after CI pushes)"
    echo "  delete    Delete deployment/service/configmap and secret (keeps namespace and ingress)"
    echo "  help      Show this help message"
}

case "${1:-help}" in
    deploy)
        check_kubectl
        check_secret_file
        check_deploy_vars
        deploy
        ;;
    status)
        check_kubectl
        status
        ;;
    logs)
        check_kubectl
        logs
        ;;
    rollout)
        check_kubectl
        rollout
        ;;
    delete)
        check_kubectl
        check_deploy_vars
        delete
        ;;
    help|*)
        usage
        ;;
esac
