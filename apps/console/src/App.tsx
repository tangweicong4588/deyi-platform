import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { LoginPage } from './pages/LoginPage';
import { AppLayout } from './pages/AppLayout';
import { TasksPage } from './pages/TasksPage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { KnowledgePage } from './pages/KnowledgePage';
import { MemoryPage } from './pages/MemoryPage';
import { UsagePage } from './pages/UsagePage';
import { ApiKeysPage } from './pages/settings/ApiKeysPage';
import { BillingPage } from './pages/settings/BillingPage';
import { QuotasPage } from './pages/settings/QuotasPage';
import { PipelinesPage } from './pages/deliver/PipelinesPage';
import { ReleasesPage } from './pages/deliver/ReleasesPage';
import { ArtifactsPage } from './pages/deliver/ArtifactsPage';
import { DoraPage } from './pages/deliver/DoraPage';
import { OpsAuthProvider } from './auth/OpsAuthContext';
import { OpsLoginPage, OpsProtectedRoute } from './auth/OpsLogin';
import { OpsLayout } from './pages/ops/OpsLayout';
import { TenantsPage } from './pages/ops/TenantsPage';
import { OffboardPage } from './pages/ops/OffboardPage';
import { AuditPage } from './pages/ops/AuditPage';
import { PlatformPage } from './pages/ops/PlatformPage';

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <AppLayout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Navigate to="/tasks" replace />} />
          <Route path="tasks" element={<TasksPage />} />
          <Route path="tasks/:taskId" element={<TaskDetailPage />} />
          <Route path="knowledge" element={<KnowledgePage />} />
          <Route path="memory" element={<MemoryPage />} />
          <Route path="usage" element={<UsagePage />} />
          <Route path="settings/keys" element={<ApiKeysPage />} />
          <Route path="settings/billing" element={<BillingPage />} />
          <Route path="settings/quotas" element={<QuotasPage />} />
          <Route path="deliver/pipelines" element={<PipelinesPage />} />
          <Route path="deliver/releases" element={<ReleasesPage />} />
          <Route path="deliver/artifacts" element={<ArtifactsPage />} />
          <Route path="deliver/dora" element={<DoraPage />} />
        </Route>
        <Route path="/ops/*" element={<OpsRoutes />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}

function OpsRoutes() {
  return (
    <OpsAuthProvider>
      <Routes>
        <Route path="login" element={<OpsLoginPage />} />
        <Route
          path="/"
          element={
            <OpsProtectedRoute>
              <OpsLayout />
            </OpsProtectedRoute>
          }
        >
          <Route index element={<Navigate to="tenants" replace />} />
          <Route path="tenants" element={<TenantsPage />} />
          <Route path="offboard" element={<OffboardPage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="platform" element={<PlatformPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/ops" replace />} />
      </Routes>
    </OpsAuthProvider>
  );
}
