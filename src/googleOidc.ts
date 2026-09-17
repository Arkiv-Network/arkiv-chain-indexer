import * as oidc from "openid-client";
import type { AuthConfig } from "./authConfig";
import type { AuthIdentity, LoginAttempt } from "./authStorage";

export interface OidcProvider {
  authorizationUrl(state: string, attempt: LoginAttempt): Promise<string>;
  authenticate(callback: URL, state: string, attempt: LoginAttempt): Promise<AuthIdentity>;
}

/** Lazy discovery: a Google outage must not interrupt browsing or existing sessions. */
export class GoogleOidcProvider implements OidcProvider {
  private configuration: Promise<oidc.Configuration> | undefined;
  constructor(private readonly config: AuthConfig, private readonly discoveryOptions?: oidc.DiscoveryRequestOptions) {}
  private getConfiguration(): Promise<oidc.Configuration> {
    if (!this.configuration) {
      this.configuration = oidc.discovery(new URL("https://accounts.google.com"), this.config.clientId,
        { client_secret: this.config.clientSecret, id_token_signed_response_alg: "RS256" }, undefined,
        { timeout: 10, ...this.discoveryOptions }).then((configuration) => {
          // Code-flow tokens otherwise rely on TLS; explicitly verify the JWT signature with Google's JWKS.
          oidc.enableNonRepudiationChecks(configuration);
          return configuration;
        }).catch((error) => { this.configuration = undefined; throw error; });
    }
    return this.configuration;
  }
  async authorizationUrl(state: string, attempt: LoginAttempt): Promise<string> {
    return oidc.buildAuthorizationUrl(await this.getConfiguration(), {
      redirect_uri: `${this.config.publicOrigin}/api/auth/google/callback`,
      scope: "openid email profile", response_type: "code", state, nonce: attempt.nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(attempt.verifier), code_challenge_method: "S256",
    }).href;
  }
  async authenticate(callback: URL, state: string, attempt: LoginAttempt): Promise<AuthIdentity> {
    const tokens = await oidc.authorizationCodeGrant(await this.getConfiguration(), callback, {
      expectedState: state, expectedNonce: attempt.nonce, pkceCodeVerifier: attempt.verifier, idTokenExpected: true,
    });
    const c = tokens.claims();
    if (!c || typeof c.sub !== "string" || !c.sub || typeof c.email !== "string" || !c.email ||
        (c.azp !== undefined && c.azp !== this.config.clientId)) throw new Error("Invalid Google identity");
    // Google tokens are discarded; only these identity fields reach the store.
    return { sub:c.sub,email:c.email.trim().toLowerCase(),emailVerified:c.email_verified === true,
      hostedDomain:typeof c.hd === "string" ? c.hd : null,
      name:typeof c.name === "string" ? c.name : c.email,
      picture:typeof c.picture === "string" && c.picture.startsWith("https://") ? c.picture : null };
  }
}
