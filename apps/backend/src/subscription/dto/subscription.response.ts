/** GET /me/subscription payload (subscription §19). snake_case wire contract. */
export interface SubscriptionResponse {
  subscription_version: number;
  status:               string;
  access_valid_until:   string | null;   // ISO
  trial_ends_at:        string | null;   // ISO
  current_period_end:   string | null;   // ISO
  show_upgrade_banner:  boolean;
  banner_severity:      'none' | 'info' | 'warning' | 'critical';
  plan: {
    code:         string;
    name:         string;
    entitlements: Record<string, number | null>;
    features:     Record<string, boolean>;
  };
}
