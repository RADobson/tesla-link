/** The portal puts redirect_uri in the fragment. Whether a non-loopback URI is accepted is unverified. */
export function sigenAuthorizationUrl(loginUrl: string, state: string, redirectUri: string, region: string): string {
  const url = new URL(loginUrl);
  url.searchParams.set("state", state);
  url.searchParams.set("client_name", "White Lotus");
  url.searchParams.set("sigen-region", region);
  url.hash = new URLSearchParams({ redirect_uri: redirectUri }).toString();
  return url.href;
}

export const SIGEN_PUBLIC_AUTHORIZATION = "Basic c2lnZW46c2lnZW4=";
