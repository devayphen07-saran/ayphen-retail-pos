/** A single active device session (client-safe fields only). */
export interface SessionResponse {
  id:               string;
  device_name:      string | null;
  os:               string | null;
  platform:         string | null;
  app_version:      string | null;
  ip_at_creation:   string | null;
  last_used_at:     string;
  last_step_up_at:  string | null;
  created_at:       string;
  is_current:       boolean;
}

/** Response after a successful step-up verification. */
export interface StepUpResponse {
  ok:           true;
  method:       string;
  completed_at: string;
  valid_until:  string;
}

/** Response when issuing a device challenge for biometric step-up. */
export interface ChallengeResponse {
  challenge_id: string;
}
