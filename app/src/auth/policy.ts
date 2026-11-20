export type RegisterDecision = "allow" | "locked" | "setup_required" | "bad_code";

/**
 * The first passkey can be created only when no credential exists.
 * If SETUP_CODE is configured, that first registration must present it.
 * Any later registration is locked, even with the setup code.
 */
export function registrationDecision(
  existingPasskeys: number,
  setupCodeConfigured: boolean,
  codeMatches: boolean,
  codeProvided: boolean,
): RegisterDecision {
  if (existingPasskeys > 0) return "locked";
  if (setupCodeConfigured && !codeMatches) return codeProvided ? "bad_code" : "setup_required";
  return "allow";
}
