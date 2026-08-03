import axios from "axios";
import { getAccessToken } from "../lib/cognitoClient";

// `VITE_API_BASE_URL` is empty locally so requests are same-origin and the dev
// proxy forwards `/mgmt` to a local gateway; in production it is the gateway origin.
const apiClient = axios.create({
  baseURL: (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "",
});

apiClient.interceptors.request.use(async (config) => {
  const token = await getAccessToken();
  if (token) {
    config.headers["Authorization"] = `Bearer ${token}`;
  }
  return config;
});

/** User-facing message pages show when the gateway can't be reached at all. */
export const NETWORK_ERROR_MESSAGE =
  "Network error: unable to reach the gateway. Check your connection and try again.";

// The app registers a handler here (from AuthContext) so a 401 can tear down the
// session without this low-level module importing React/router state directly.
type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

// Response interceptor:
//  - 401: the bearer token is gone or rejected. Sign out (which flips auth state
//    to "signedOut"); RequireAuth then redirects to /login and preserves the
//    intended location in router state so the user lands back where they were.
//  - network error (no HTTP response — DNS/offline/CORS/timeout): reject with a
//    normalized Error so every page renders one consistent, readable message.
apiClient.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 401) {
        unauthorizedHandler?.();
      } else if (!error.response) {
        return Promise.reject(new Error(NETWORK_ERROR_MESSAGE));
      }
    }
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  },
);

export default apiClient;
