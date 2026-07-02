/** Response after successful login/signup (stage 2). */
export interface LoginResponse {
  access_token:          string;
  refresh_token:         string;
  user:                  AuthUserResponse;
  is_new_user:           boolean;
  device_guuid:          string;
  device_session_guuid:  string;
  is_trusted:            boolean;
}

export interface AuthUserResponse {
  id:                  string;
  permissions_version: number;
}

/** Response after a token refresh / rotation. */
export interface RefreshResponse {
  access_token:     string;
  refresh_token:    string;
  snapshot_version: number;
}
