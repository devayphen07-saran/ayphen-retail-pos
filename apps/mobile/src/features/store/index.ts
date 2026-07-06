// The store feature is split into modules (home, locations, roles, staff,
// subscription, more, devices). This root barrel re-exports only the SHARED
// store-creation surface used by other features (onboarding, app gate); each
// module is imported via its own barrel (@features/store/<module>).
export * from './shared';
