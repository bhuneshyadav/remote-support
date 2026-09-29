import { User, UserManager, WebStorageStateStore } from "oidc-client-ts";

const localDevBypassEnabled = import.meta.env.VITE_ALLOW_LOCAL_DEV_BYPASS === "true";
const apiAudience = import.meta.env.VITE_OIDC_API_AUDIENCE || "remote-support-api";

const settings = {
  authority: import.meta.env.VITE_OIDC_AUTHORITY || "https://your-tenant.auth0.com",
  client_id: import.meta.env.VITE_OIDC_CLIENT_ID || "YOUR_AUTH0_SPA_CLIENT_ID",
  redirect_uri: `${window.location.origin}/auth/callback`,
  post_logout_redirect_uri: window.location.origin,
  response_type: "code",
  scope: "openid profile",
  extraQueryParams: {
    audience: apiAudience,
    resource: apiAudience,
  },
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
};

export const userManager = new UserManager(settings);

export function setLocalDevAccessToken() {
  if (!localDevBypassEnabled) {
    throw new Error("local_dev_bypass_disabled");
  }

  const localUser = new User({
    id_token: "",
    session_state: "",
    access_token: "local-dev-access-token",
    refresh_token: "",
    token_type: "Bearer",
    scope: "openid profile",
    profile: {
      sub: "local-dev-technician",
      name: "Local Technician",
      email: "local@local.dev",
      iss: "local-dev",
      aud: "remote-support-api",
      exp: Number.MAX_SAFE_INTEGER,
      iat: Math.floor(Date.now() / 1000),
    },
    expires_at: Number.MAX_SAFE_INTEGER,
  });

  return userManager.storeUser(localUser);
}

export function isLocalDevBypassEnabled() {
  return localDevBypassEnabled;
}