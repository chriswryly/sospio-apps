export function signingOptions(env) {
  const names = ["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "APPLE_SIGNING_IDENTITY", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];
  const complete = names.every(name => Boolean(env[name]));
  if (!complete) return {enabled: false, environment: {}, arguments: []};
  return {enabled: true, environment: {CSC_LINK: env.APPLE_CERTIFICATE, CSC_KEY_PASSWORD: env.APPLE_CERTIFICATE_PASSWORD,
    APPLE_ID: env.APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD: env.APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID: env.APPLE_TEAM_ID},
  arguments: ["-c.mac.identity=" + env.APPLE_SIGNING_IDENTITY, "-c.mac.hardenedRuntime=true", "-c.mac.notarize=true"]};
}
