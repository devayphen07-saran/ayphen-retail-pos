export interface MobilePrincipal {
  userId:             string;
  userGuuid:          string;
  deviceSessionId:    string;
  deviceId:           string;
  devicePlatform:     string;
  permissionsVersion: number;   // current, from the DB user row (loaded this request)
  jwtPv:              number;    // permissionsVersion baked into the JWT at issue (H-6, §16)
  stepUpAt?:          Date;
  stepUpMethod?:      string;
  // Always set by MobileJwtGuard (the sole place req.user is constructed)
  // from the verified JWT's jti/exp claims — required, not optional, so a
  // consumer can read them without an inline `!` assertion.
  currentJti:         string;    // the JWT's jti — for logout blacklisting
  currentJtiExp:      Date;      // when that jti expires
}

declare global {
  namespace Express {
    interface Request {
      user?: MobilePrincipal;
    }
  }
}
