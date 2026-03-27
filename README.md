# GKE Advanced Lab

A hands-on lab for deploying a full-stack Todo application on Google Kubernetes Engine (GKE), following production-grade practices.

## Architecture Overview

```
User (HTTPS)
     ↓
GKE L7 Gateway (Google-managed SSL, sslip.io)
     ↓
HTTPRoute: /api/* → backend-svc | /* → frontend-svc
     ↓                              ↓
Backend Pods (FastAPI)        Frontend Pods (Nginx)
     ↓
Cloud SQL MySQL (Private IP)
     ↓
Secret Manager (DB password, GitHub token)
Workload Identity (IAM, no credential files)
```

**CI/CD Flow:**
```
Push code → GitHub
     ↓
Cloud Build (trigger via Secret Manager PAT)
     ↓
Build & push Docker images → Artifact Registry
     ↓
Update helm/myapp/values.yaml (image tag)
     ↓
ArgoCD detects change → helm upgrade
     ↓
Rolling update on GKE
```

## Stack

| Component | Technology |
|---|---|
| Frontend | Nginx serving static HTML/CSS/JS |
| Backend | FastAPI (Python) |
| Database | Cloud SQL MySQL (Private IP) |
| Container Registry | Artifact Registry |
| Kubernetes | GKE Standard + Gateway API |
| Load Balancer | GKE L7 Global External (Gateway API) |
| SSL | Google-managed Certificate (Certificate Manager) |
| Secrets | Secret Manager + Workload Identity |
| CI | Cloud Build (2nd gen, repo via Secret) |
| GitOps | ArgoCD (Helm source) |
| Deployment | Helm chart |

## Project Structure

```
.
├── backend/
│   ├── main.py
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   ├── index.html
│   ├── style.css
│   └── app.js
├── helm/
│   └── myapp/
│       ├── Chart.yaml
│       ├── values.yaml
│       └── templates/
│           ├── serviceaccount.yaml
│           ├── configmap.yaml
│           ├── deployment-backend.yaml
│           ├── deployment-frontend.yaml
│           ├── service-backend.yaml
│           ├── service-frontend.yaml
│           ├── gateway.yaml
│           └── httproute.yaml
├── argocd/
│   └── application.yaml
├── cloudbuild.yaml
└── docker-compose.yml
```

## Key Design Decisions

| Decision | Reason |
|---|---|
| Gateway API (L7) instead of `type: LoadBalancer` | One IP for all services, host/path routing, TLS termination |
| sslip.io | Free DNS, no domain purchase needed for lab |
| Google-managed certificate | Zero-config TLS, auto-renew |
| Cloud Build 2nd gen (Secret PAT) | Reproducible, no OAuth UI click |
| Helm chart | Templating, multi-env, rollback support |
| ArgoCD Helm source | GitOps, auto-sync on values.yaml change |
| Workload Identity | No credential files in pods |

## Local Development

```bash
docker compose up
```

App runs at `http://localhost:8000`, requires a local MySQL instance.

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check |
| GET | `/todos` | List all todos |
| POST | `/todos` | Create a todo |
| PUT | `/todos/{id}` | Update a todo |
| DELETE | `/todos/{id}` | Delete a todo |
