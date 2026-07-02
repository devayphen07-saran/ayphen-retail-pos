/**
 * DI tokens for the auth-core layer, in their own file so services that inject
 * them don't import from auth-core.module.ts (which imports those services) —
 * a cycle that leaves the token undefined at decoration time and breaks DI.
 */
export const CORE_REDIS = Symbol('CORE_REDIS');
