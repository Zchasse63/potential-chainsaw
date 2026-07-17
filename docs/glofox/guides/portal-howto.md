Use this how-to the first time you open the ABC Fitness Developer Portal. Use it if you are new to the Glofox API or if you previously used the previous developer docs site. If you already have an account, skip to Request API access.  
  
## Prerequisites

  * A work email address
  * Your business or studio name, Branch IDs or namespace (if you know them), and a short description of your integration use case



If you only need to read documentation, you can skip account creation. You must [log in](/login) to use **Request access**.

## API overview

Glofox's API uses the REST protocol. The API enables external applications to access, create, and edit users, memberships, credits, classes, bookings & payments. Each endpoint returns JSON responses.

Include these headers in every API call:

  * `x-glofox-branch-id`
  * `x-api-key`
  * `x-glofox-api-token`



## Open the portal

  1. Go to <https://api-portal.glofox.com/api-portal/#/>.
  2. Bookmark this URL.



If you still have bookmarks to the previous developer docs site, replace them with the portal URL in the preceding step.

## Create an account or log in

### If you do not have a portal account yet

  1. Select [Sign up](/signup).
  2. Enter your email address and password, and accept the API Terms of Use and Privacy Policy.
  3. Complete sign-up, then [log in](/login).



### If you already have an account

  1. Select [Log in](/login).
  2. Enter your email address and password.



### If you forgot your password

  1. On the log-in page, select **Forgot password?**
  2. Follow the email instructions, then [log in](/login) with your new password.



## Explore the documentation

  1. On the home page, open the **Glofox** portal card (**Enter portal**) to reach this page.
  2. Use the sidebar for guides ([Authentication](/glofox/authentication), [Common concepts](/glofox/common-concepts), [Error handling](/glofox/error-handling), [Webhooks](/glofox/webhooks), and Flows).
  3. Use the [API Reference](https://api-portal.glofox.com/api-portal/glofox/api/openapi-reference.html) when you need the interactive OpenAPI reference.



__

New to the API? Continue with[Authentication](/glofox/authentication), skim [Common concepts](/glofox/common-concepts), then use the [API Reference](https://api-portal.glofox.com/api-portal/glofox/api/openapi-reference.html) as you implement.

## Request API access

You need an API key and API token (`x-api-key` and `x-glofox-api-token`) for backend integrations. Request them from the portal. Do not send the old email template to `apiactivation@abcfitness.com` for new requests.

  1. Make sure you are logged in.
  2. In the top navigation, select [Request access](/glofox/request-access).
  3. Choose requester type (customer or partner).
  4. Fill in intended use case, Branch IDs or namespace values, expected daily volume, and the integration you need (including Zapier if required).
  5. Submit the form.
  6. Check the same page for status (**Request submitted** , **Approved** , or **Rejected**).



__

The API token and the Zapier integration token are different credentials. Request each one through the portal when you need it.

__

Use the API key and token only from a secure backend.**Do not** call Glofox API endpoints from browser or client-side code. These requests require credentials; exposing them in client-side code exposes those secrets. Make all API calls from a backend where you store and manage credentials safely.

## Important notes

  * Use the API key and token only for backend integrations, not in browsers. If you need to use this API key, proxy requests through your backend so it makes the authenticated call to the API Gateway and keeps the key and token private.

  * Regarding timestamps, most of the API uses UTC. When a field uses the "local" timezone, it refers to the current location (`branch`) time.

  * When requesting API access, you can request a Zapier integration token on the same form or later from the Request access page if you did not include it on your first submission. **The API token and Zapier integration token are different credentials**. Request each through the portal when you need it.




__

To properly calculate the actual price of purchasing a resource (with discounts and taxes included), you should pass the relevant info to the[`/2.2/branches/{branchId}/price-breakdown`](https://api-portal.glofox.com/api-portal/glofox/api/openapi-reference.html#tag/Price-Calculator/paths/~12.2~1branches~1%7BbranchId%7D~1price-breakdown/post) endpoint.

## Request webhook access

Webhook access is not granted through the **Request access** form. To enable webhooks for your integration:

  1. Read the [Webhooks](/glofox/webhooks) guide for timeouts, retries, and signature validation.
  2. Review available webhook payloads in the [API Reference](https://api-portal.glofox.com/api-portal/glofox/api/openapi-reference.html#tag/Webhooks).
  3. Contact [apiactivation@abcfitness.com](mailto:apiactivation@abcfitness.com) to request webhook configuration.



### Webhooks request email template

When you request webhook access, include the following information:
    
    
    Subject: Webhooks Setup Request
    
    Business / Studio name:
    Contact name & email:
    Branch ID(s) / Namespace (if known):
    Environments required (Production / Staging + Production):
    Target start date:
    Webhook event domains and their callback URLs. Example: 
      BOOKINGS: https://mydomain.com/webhooks/bookings; 
      MEMBERSHIPS: https://mydomain.com/webhooks/memberships

 __

You can configure webhook URLs by event domain (`BOOKINGS`, `MEMBERSHIPS`, `ACCESS`, and others) or use a single URL for all events. Each webhook includes a `signature` HTTP header that signs the payload. Validate that signature so you accept only authentic Glofox events. See [Webhooks](/glofox/webhooks) for details.

## Coming from the old docs site?

You used to… | Do this instead  
---|---  
Send an access-request template by email | [Sign up](/signup) / [Log in](/login), then use [Request access](/glofox/request-access)  
Browse Overview and Flows | Open **Enter portal** → sidebar docs and Flows  
Open the old OpenAPI UI | Use the [API Reference](https://api-portal.glofox.com/api-portal/glofox/api/openapi-reference.html) in the portal  
  
## If something goes wrong

  * **Cannot log in:** Use **Forgot password?** or confirm you signed up on this portal (accounts from other ABC systems do not apply here).
  * **Request access is missing:** Log in first; the link is shown for authenticated users.
  * **Need help with API behavior:** Contact [glofox.apisupport@abcfitness.com](mailto:glofox.apisupport@abcfitness.com).


