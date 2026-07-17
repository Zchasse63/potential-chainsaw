This section describes authentication and authorization for the Glofox API. All API requests must include the following headers: `x-glofox-branch-id`, `x-api-key`, and `x-glofox-api-token`.

Header | Description  
---|---  
`x-glofox-branch-id` | Branch ID for the current request.  
`x-api-key` | API key for the integration.  
`x-glofox-api-token` | API token for the integration.  
  
__

Security

Always proxy API key and token requests through a secure backend. Never expose credentials in client-side applications.

## Get started

First, you need API credentials. Follow [Get started](/glofox) to create an account, log in, and submit **Request access** from the top navigation.

You receive credentials that grant access to the development endpoints. The Glofox API provides dedicated development, testing, staging, and sandbox environments to support end‑to‑end validation. Glofox issues two sets of tokens/keys: one for development/testing and one for production. Both sets point to the same environment configuration. The API supports webhook configuration. You need access to the Glofox Dashboard to complete development and testing workflows.

__

To verify your credentials, send a`GET` request to [`/2.0/members`](https://api-portal.glofox.com/api-portal/glofox/api/openapi-reference.html#tag/Users/paths/~12.0~1members/get) (for example `https://gf-api.aws.glofox.com/prod/2.0/members`) with the required headers.

## Security and rate limiting

The API applies security validations and rate limits. The main measures are those listed below.

**Backend proxies:** perform all API key and token operations through a secure backend service. This prevents direct client‑side access and protects sensitive credentials. Use API keys and tokens exclusively for backend integrations. Never expose them in browsers or other public-facing environments. Implement strong credential lifecycle management, including rotation and secure storage.

**Rate limiting:** the API enforces per-second limits and burst allowances:

  * **Live accounts:** 10 requests per second with a burst of 1000.
  * **Sandbox accounts:** 3 requests per second with a burst of 300.



__

Burst

_Burst_ is the maximum number of requests you can send in a short time window before the per-second limit applies. It lets you briefly exceed the sustained rate, then you must return to the sustained rate.

## Payment collector iframe

If you use the payment collector iframe, request domain authorization via email or Slack. The domain `https://localhost` is pre-authorized for local development.
