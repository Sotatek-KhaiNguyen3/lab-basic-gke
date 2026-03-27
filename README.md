# GKE Basic Lab

A hands-on lab for deploying a full-stack Todo application on Google Kubernetes Engine (GKE) Autopilot, following production-grade practices.

## Architecture Overview

```
User → Cloud Storage (Frontend) → LoadBalancer Service → GKE Backend Pods → Cloud SQL (MySQL)
                                                                ↑
                                                     Secret Manager (DB password)
                                                     Workload Identity (IAM)
                                                     ArgoCD (GitOps sync)
```

**Stack:**
- **Frontend:** Static HTML/CSS/JS hosted on Google Cloud Storage
- **Backend:** FastAPI (Python) running on GKE Autopilot
- **Database:** Cloud SQL for MySQL (Private IP)
- **Secrets:** Google Cloud Secret Manager (fetched directly by the app)
- **GitOps:** ArgoCD syncing manifests from GitHub
- **Monitoring:** GCP native (Cloud Monitoring + Cloud Logging)

## Prerequisites

- GCP project with billing enabled
- `gcloud` CLI configured
- `kubectl` configured
- `helm` installed
- Docker (for local development only)

## Workflow

### 1. Setup GCP Infrastructure

```bash
# Enable required APIs
gcloud services enable container.googleapis.com sqladmin.googleapis.com \
  secretmanager.googleapis.com artifactregistry.googleapis.com

# Create Artifact Registry repository
gcloud artifacts repositories create my-app-repo \
  --repository-format=docker \
  --location=asia-southeast1

# Create GKE Autopilot cluster
gcloud container clusters create-auto backend-cluster \
  --region=asia-southeast1

# Create Cloud SQL (MySQL 8.0, Private IP)
gcloud sql instances create mydb-instance \
  --database-version=MYSQL_8_0 \
  --tier=db-custom-1-3840 \
  --region=asia-southeast1 \
  --no-assign-ip \
  --network=projects/PROJECT_ID/global/networks/default

gcloud sql databases create appdb --instance=mydb-instance
gcloud sql users create appuser --instance=mydb-instance --password='YOUR_PASSWORD'
```

### 2. Setup Secret Manager

```bash
# Store DB password in Secret Manager (single source of truth)
echo -n 'YOUR_PASSWORD' | gcloud secrets create db-pass --data-file=-
```

### 3. Setup Workload Identity

Allows GKE pods to access Secret Manager without credential files.

```bash
# Create GCP Service Account
gcloud iam service-accounts create backend-sa

# Grant access to Secret Manager
gcloud secrets add-iam-policy-binding db-pass \
  --member="serviceAccount:backend-sa@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# Create K8s Service Account and bind
kubectl create serviceaccount backend-sa

gcloud iam service-accounts add-iam-policy-binding backend-sa@PROJECT_ID.iam.gserviceaccount.com \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:PROJECT_ID.svc.id.goog[default/backend-sa]"

kubectl annotate serviceaccount backend-sa \
  iam.gke.io/gcp-service-account=backend-sa@PROJECT_ID.iam.gserviceaccount.com
```

### 4. Build & Push Backend Image

```bash
# Build and push via Cloud Build (recommended over docker push)
gcloud builds submit ./backend \
  --tag asia-southeast1-docker.pkg.dev/PROJECT_ID/my-app-repo/backend:1.0.0
```

### 5. Deploy with kubectl / ArgoCD

**Apply manifests manually:**
```bash
kubectl apply -f manifests/
```

**Or set up ArgoCD (GitOps):**
```bash
helm repo add argo https://argoproj.github.io/argo-helm
helm repo update
helm install argocd argo/argo-cd --namespace argocd --create-namespace \
  --set configs.params."server\.insecure"=true

kubectl apply -f manifests/application.yaml
```

### 6. Deploy Frontend

```bash
# Create public GCS bucket
gcloud storage buckets create gs://YOUR_BUCKET_NAME --location=asia-southeast1

# Make public
gcloud storage buckets add-iam-policy-binding gs://YOUR_BUCKET_NAME \
  --member=allUsers --role=roles/storage.objectViewer

# Upload frontend files
gcloud storage cp frontend/* gs://YOUR_BUCKET_NAME/
```

### 7. Access the App

```bash
# Get backend external IP
kubectl get svc backend-svc

# Frontend URL
http://YOUR_BUCKET_NAME.storage.googleapis.com/index.html
```

## Project Structure

```
.
├── backend/
│   ├── main.py          # FastAPI app (reads DB password from Secret Manager)
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   ├── index.html
│   ├── style.css
│   └── app.js           # API_BASE points to backend LoadBalancer IP
├── manifests/
│   ├── deployment.yaml  # Backend deployment (uses backend-sa)
│   ├── service.yaml     # LoadBalancer service
│   ├── configmap.yaml   # Non-sensitive config (DB_HOST, DB_NAME, etc.)
│   └── application.yaml # ArgoCD Application
├── docker-compose.yml   # Local development
└── tutorial.md          # Step-by-step lab guide
```

## Key Design Decisions

| Decision | Reason |
|---|---|
| Secret Manager instead of K8s Secret | Single source of truth, proper encryption, audit logging |
| App fetches secret directly | No ESO/CSI complexity needed |
| Workload Identity | No credential files, IAM-based auth |
| Cloud Build instead of `docker push` | Cloud Shell blocks direct Docker push |
| GKE Autopilot | No node management overhead |
| ArgoCD for GitOps | Auto-sync manifests from Git |

## Local Development

```bash
docker compose up
```

App runs at `http://localhost:8000`, requires a local MySQL instance.

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/` | Health check |
| GET | `/health` | Health check |
| GET | `/todos` | List all todos |
| POST | `/todos` | Create a todo |
| PUT | `/todos/{id}` | Update a todo |
| DELETE | `/todos/{id}` | Delete a todo |


# trigger test