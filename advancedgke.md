# Advanced GKE Lab — Step-by-Step Guide

> **Stack:** FastAPI backend + Nginx frontend + Cloud SQL MySQL
> **Điểm nâng cấp so với lab cơ bản:**
> - L7 Load Balancer qua **Gateway API** + **Google-managed SSL** — không cần domain thật, dùng sslip.io
> - Kết nối GitHub repo bằng **Secret Manager + gcloud CLI** — không click UI
> - Deploy bằng **Helm chart** — GitOps qua ArgoCD

---

## Bước 0 — Biến môi trường (làm trước tiên, một lần duy nhất)

**Terminal:** Toàn bộ lab này chạy trên **Google Cloud Shell** (trình duyệt → GCP Console → click icon Cloud Shell góc trên phải). Không cần cài gcloud local.

**Tạo file `.env` trên Cloud Shell:**

```bash
# Clone repo về Cloud Shell trước
git clone https://github.com/Sotatek-KhaiNguyen3/lab-basic-gke.git
cd lab-basic-gke

# Tạo file .env ngay trong thư mục repo
cat > .env << 'EOF'
export PROJECT_ID="project-for-lab"
export REGION="asia-southeast1"
export ZONE="asia-southeast1-a"
export CLUSTER_NAME="gke-advanced"
export REPO_NAME="my-app-repo"
export GITHUB_REPO="Sotatek-KhaiNguyen3/lab-basic-gke"
EOF

# Load biến vào session hiện tại
source .env

# Kiểm tra
echo $PROJECT_ID   # → project-for-lab
```

> **Mỗi lần mở Cloud Shell mới** phải `cd lab-basic-gke && source .env` lại — Cloud Shell không lưu biến giữa các session.
> `.env` đã có trong `.gitignore` — không bị commit lên repo.
> `$DOMAIN` sẽ được tạo tự động từ IP của Gateway ở Phần 10, không cần khai báo trước.

---

## Phần 1 — Tạo Project & Enable APIs

```bash
gcloud projects create $PROJECT_ID --name="GKE Advanced Lab"
gcloud config set project $PROJECT_ID

# Gắn billing (lấy ID từ: gcloud billing accounts list)
gcloud billing projects link $PROJECT_ID \
  --billing-account=BILLING_ACCOUNT_ID

gcloud services enable \
  container.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  sqladmin.googleapis.com \
  servicenetworking.googleapis.com \
  certificatemanager.googleapis.com \
  iam.googleapis.com \
  cloudresourcemanager.googleapis.com
```

> **Check Console:** APIs & Services → Enabled APIs — xác nhận 9 APIs active.

---

## Phần 2 — Network

```bash
gcloud compute networks create lab-vpc --subnet-mode=custom

gcloud compute networks subnets create gke-subnet \
  --network=lab-vpc \
  --region=$REGION \
  --range=10.0.0.0/20 \
  --secondary-range pods=10.4.0.0/14,services=10.0.16.0/20

# Private Service Access cho Cloud SQL
gcloud compute addresses create google-managed-services \
  --global \
  --purpose=VPC_PEERING \
  --prefix-length=16 \
  --network=lab-vpc

gcloud services vpc-peerings connect \
  --service=servicenetworking.googleapis.com \
  --ranges=google-managed-services \
  --network=lab-vpc

# Cho phép health check từ Google LB
gcloud compute firewall-rules create allow-health-check \
  --network=lab-vpc \
  --action=allow \
  --direction=ingress \
  --source-ranges=130.211.0.0/22,35.191.0.0/16 \
  --rules=tcp
```

> **Check Console:** VPC Network → `lab-vpc` → Subnets — thấy `gke-subnet` với 2 secondary ranges.

---

## Phần 3 — Cloud SQL

```bash
gcloud sql instances create lab-mysql \
  --database-version=MYSQL_8_0 \
  --tier=db-f1-micro \
  --region=$REGION \
  --network=lab-vpc \
  --no-assign-ip \
  --enable-google-private-path

gcloud sql databases create appdb --instance=lab-mysql

gcloud sql users create appuser \
  --instance=lab-mysql \
  --password=STRONG_PASSWORD_HERE
```

```bash
# Lưu Private IP lại để dùng sau
MYSQL_IP=$(gcloud sql instances describe lab-mysql \
  --format='value(ipAddresses[0].ipAddress)')
echo "MySQL Private IP: $MYSQL_IP"
```

> **Check Console:** SQL → `lab-mysql` → Private IP đã assign, Status: Runnable.

---

## Phần 4 — Artifact Registry

```bash
gcloud artifacts repositories create $REPO_NAME \
  --repository-format=docker \
  --location=$REGION
```

> **Check Console:** Artifact Registry → `my-app-repo`.

---

## Phần 5 — Secret Manager

```bash
# DB password
echo -n "STRONG_PASSWORD_HERE" | gcloud secrets create db-pass --data-file=-

# GitHub Personal Access Token (cần quyền: repo full, admin:repo_hook)
echo -n "ghp_YOUR_TOKEN_HERE" | gcloud secrets create github-token --data-file=-

gcloud secrets list
```

> **Check Console:** Security → Secret Manager — thấy `db-pass` và `github-token`.

---

## Phần 6 — GKE Cluster

```bash
gcloud container clusters create $CLUSTER_NAME \
  --zone=$ZONE \
  --network=lab-vpc \
  --subnetwork=gke-subnet \
  --cluster-secondary-range-name=pods \
  --services-secondary-range-name=services \
  --enable-ip-alias \
  --workload-pool="${PROJECT_ID}.svc.id.goog" \
  --num-nodes=2 \
  --machine-type=e2-medium \
  --gateway-api=standard

gcloud container clusters get-credentials $CLUSTER_NAME --zone=$ZONE

# Xác nhận Gateway API đã sẵn sàng
kubectl get gatewayclass
```

Output mong đợi:
```
NAME                              CONTROLLER
gke-l7-global-external-managed   networking.gke.io/gateway
gke-l7-regional-external-managed networking.gke.io/gateway
...
```

> **Check Console:** Kubernetes Engine → `gke-advanced` → Details → Gateway API: Enabled.

---

## Phần 7 — Service Account & Workload Identity

```bash
# Tạo GCP SA cho backend Pod
gcloud iam service-accounts create backend-sa \
  --display-name="Backend Workload SA"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:backend-sa@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:backend-sa@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/cloudsql.client"

# Bind K8s SA → GCP SA (Workload Identity)
# Lưu ý: Helm chart sẽ tạo backend-ksa, nhưng binding phải làm trước khi deploy
gcloud iam service-accounts add-iam-policy-binding \
  "backend-sa@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:${PROJECT_ID}.svc.id.goog[default/backend-ksa]"
```

> **Check Console:** IAM → Service Accounts → `backend-sa`.

---

## Phần 8 — Kết nối GitHub bằng Secret (không dùng UI)

```bash
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID \
  --format='value(projectNumber)')

# Grant Cloud Build SA quyền đọc GitHub token
gcloud secrets add-iam-policy-binding github-token \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-cloudbuild.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# Tạo connection — dùng secret thay vì OAuth UI
gcloud builds connections create github lab-github-conn \
  --region=$REGION \
  --authorizer-token-secret-version="projects/${PROJECT_ID}/secrets/github-token/versions/latest"

# Link repo vào connection
gcloud builds repositories create lab-repo \
  --connection=lab-github-conn \
  --remote-uri="https://github.com/${GITHUB_REPO}.git" \
  --region=$REGION

# Xác nhận
gcloud builds connections list --region=$REGION
gcloud builds repositories list --connection=lab-github-conn --region=$REGION
```

> **Check Console:** Cloud Build → Settings → Repository connections → `lab-github-conn` — Status: **Installation successful**.

---

## Phần 9 — Helm Chart

Chart đã có sẵn trong repo tại `helm/myapp/`. Cấu trúc:

```
helm/myapp/
├── Chart.yaml
├── values.yaml
└── templates/
    ├── serviceaccount.yaml
    ├── configmap.yaml
    ├── deployment-backend.yaml
    ├── deployment-frontend.yaml
    ├── service-backend.yaml      ← ClusterIP
    ├── service-frontend.yaml     ← ClusterIP
    ├── gateway.yaml              ← L7 LB + certMap
    └── httproute.yaml            ← /api/* → backend, /* → frontend
```

Trước khi deploy, cập nhật `helm/myapp/values.yaml`:

```bash
# Điền Private IP của Cloud SQL vào values.yaml
sed -i "s|host: \"10.0.0.X\"|host: \"${MYSQL_IP}\"|" helm/myapp/values.yaml
sed -i "s|project: project-for-lab|project: ${PROJECT_ID}|" helm/myapp/values.yaml
```

Kiểm tra render trước khi deploy:

```bash
helm template myapp helm/myapp/
```

---

## Phần 10 — Deploy & SSL (sslip.io)

Vì Google-managed cert cần domain name (không dùng bare IP được), ta dùng **sslip.io** — dịch vụ DNS miễn phí tự resolve `<IP>.sslip.io` → IP đó. Không cần mua domain, không cần Cloud DNS.

### Bước 1: Deploy Helm chart (chưa có cert, chỉ có listener HTTP trước)

```bash
helm install myapp helm/myapp/
```

### Bước 2: Chờ Gateway có External IP

```bash
kubectl get gateway lab-gateway -w
# Chờ cột ADDRESS xuất hiện IP
```

```bash
GATEWAY_IP=$(kubectl get gateway lab-gateway \
  -o jsonpath='{.status.addresses[0].value}')

# Tạo domain từ IP (thay . bằng -)
DOMAIN="${GATEWAY_IP//./-}.sslip.io"
echo "Domain: $DOMAIN"   # vd: 34-120-50-100.sslip.io
```

### Bước 3: Tạo Certificate Manager cert

```bash
gcloud certificate-manager certificates create lab-cert \
  --domains="$DOMAIN" \
  --global

gcloud certificate-manager maps create lab-cert-map

gcloud certificate-manager maps entries create lab-cert-entry \
  --map=lab-cert-map \
  --certificates=lab-cert \
  --hostname="$DOMAIN"

# Theo dõi trạng thái (cần ~10-15 phút)
watch gcloud certificate-manager certificates describe lab-cert \
  --format='value(managed.state)'
# Chờ: ACTIVE
```

> **Check Console:** Certificate Manager → Certificates → `lab-cert` — PROVISIONING → ACTIVE.

### Bước 4: Cập nhật Helm với domain thật và upgrade

```bash
helm upgrade myapp helm/myapp/ \
  --set domain=$DOMAIN \
  --set certMap=lab-cert-map
```

---

## Phần 11 — Cloud Build CI Pipeline

Tạo `cloudbuild.yaml` ở root repo:

```yaml
steps:
  - name: 'gcr.io/cloud-builders/docker'
    args: [build, -t, '${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO}/backend:$SHORT_SHA', ./backend]

  - name: 'gcr.io/cloud-builders/docker'
    args: [build, -t, '${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO}/frontend:$SHORT_SHA', ./frontend]

  - name: 'gcr.io/cloud-builders/docker'
    args: [push, '${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO}/backend:$SHORT_SHA']

  - name: 'gcr.io/cloud-builders/docker'
    args: [push, '${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO}/frontend:$SHORT_SHA']

  # Cập nhật image tag trong Helm values rồi push lại repo → ArgoCD tự sync
  - name: 'alpine/git'
    entrypoint: sh
    args:
      - '-c'
      - |
        git config user.email "cloudbuild@ci"
        git config user.name "Cloud Build"
        sed -i "s|tag: .*|tag: $SHORT_SHA|" helm/myapp/values.yaml
        git add helm/myapp/values.yaml
        git diff --cached --quiet || git commit -m "ci: bump image tag to $SHORT_SHA [skip ci]"
        git push origin HEAD

substitutions:
  _REGION: asia-southeast1
  _REPO: my-app-repo

options:
  logging: CLOUD_LOGGING_ONLY
```

```bash
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')

# Grant AR writer cho Cloud Build SA
gcloud artifacts repositories add-iam-policy-binding $REPO_NAME \
  --location=$REGION \
  --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"

# Lấy resource name của repo đã connect
REPO_RESOURCE=$(gcloud builds repositories describe lab-repo \
  --connection=lab-github-conn \
  --region=$REGION \
  --format='value(name)')

# Tạo trigger
gcloud builds triggers create github \
  --name=build-on-push \
  --region=$REGION \
  --repository="$REPO_RESOURCE" \
  --branch-pattern="^main$" \
  --build-config=cloudbuild.yaml
```

> **Check Console:** Cloud Build → Triggers → `build-on-push` — Connected repository: `lab-github-conn / lab-repo`.

---

## Phần 12 — ArgoCD

```bash
kubectl create namespace argocd

kubectl apply -n argocd \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

kubectl wait --for=condition=available deployment/argocd-server \
  -n argocd --timeout=120s

# Lấy mật khẩu admin
kubectl get secret argocd-initial-admin-secret -n argocd \
  -o jsonpath="{.data.password}" | base64 -d && echo

# Truy cập UI
kubectl port-forward svc/argocd-server -n argocd 8080:443
```

Tạo file `argocd/application.yaml` trong repo:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: myapp
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/Sotatek-KhaiNguyen3/lab-basic-gke.git
    targetRevision: HEAD
    path: helm/myapp
    helm:
      valueFiles:
        - values.yaml
  destination:
    server: https://kubernetes.default.svc
    namespace: default
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

```bash
kubectl apply -f argocd/application.yaml

kubectl get application myapp -n argocd
```

---

## Phần 13 — Verify

```bash
# Health check backend
curl -s https://$DOMAIN/api/health
# → {"status": "ok"}

# Frontend
curl -I https://$DOMAIN/
# → HTTP/2 200

# Helm release
helm list -n default
# → myapp   default   DEPLOYED

# ArgoCD sync
kubectl get application myapp -n argocd \
  -o jsonpath='{.status.sync.status}'
# → Synced
```

---

## Luồng CI/CD hoàn chỉnh

```
Push code → GitHub
     ↓
Cloud Build trigger (repo kết nối qua Secret, không qua UI)
     ↓
Build Docker images → push Artifact Registry
     ↓
Cập nhật helm/myapp/values.yaml (tag = SHORT_SHA) → push repo
     ↓
ArgoCD phát hiện thay đổi trong Helm chart
     ↓
helm upgrade tự động trên GKE
     ↓
Traffic: Internet → L7 Gateway (HTTPS/sslip.io) → HTTPRoute → ClusterIP → Pods
```
