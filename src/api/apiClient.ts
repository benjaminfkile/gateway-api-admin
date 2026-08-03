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

export default apiClient;
