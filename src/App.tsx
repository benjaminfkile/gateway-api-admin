import { Route, Routes } from "react-router-dom";
import AppShell from "./components/AppShell";
import ErrorBoundary from "./components/ErrorBoundary";
import RequireAuth from "./components/RequireAuth";
import LoginPage from "./pages/LoginPage";
import ServicesPage from "./pages/ServicesPage";
import DeploysPage from "./pages/DeploysPage";
import InstancesPage from "./pages/InstancesPage";
import LogsPage from "./pages/LogsPage";
import NodeStatsPage from "./pages/NodeStatsPage";
import NotFoundPage from "./pages/NotFoundPage";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <ErrorBoundary>
              <AppShell />
            </ErrorBoundary>
          </RequireAuth>
        }
      >
        <Route path="/" element={<ServicesPage />} />
        <Route path="/deploys" element={<DeploysPage />} />
        <Route path="/instances" element={<InstancesPage />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route path="/stats" element={<NodeStatsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
