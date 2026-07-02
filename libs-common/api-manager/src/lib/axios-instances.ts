import axios from "axios";

export const apiBaseURL =
  process.env.NEXT_PUBLIC_API_URL ??
  process.env.EXPO_PUBLIC_API_URL;

const isMobile = !!process.env.EXPO_PUBLIC_API_URL;

export const API = axios.create({
  baseURL:         apiBaseURL ?? '',
  timeout:         15000,
  withCredentials: !isMobile,
  headers: {
    "Content-Type":    "application/json",
    "Accept-Encoding": "gzip, deflate",
  },
});

// Validate at request time, not import time — allows the module to be imported
// in test environments without the env var set (tests can set API.defaults.baseURL).
API.interceptors.request.use((config) => {
  if (!apiBaseURL && !config.baseURL) {
    return Promise.reject(
      new Error(
        "[api-handler] API base URL not set. " +
        "Set NEXT_PUBLIC_API_URL (web) or EXPO_PUBLIC_API_URL (mobile).",
      ),
    );
  }
  return config;
});
