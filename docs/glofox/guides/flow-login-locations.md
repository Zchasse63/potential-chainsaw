Use the following workflow to resolve bundle‑scoped locations and perform credential verification.

## List locations (`GET`)

Retrieve a list of all branches (locations) associated with a specific bundle.

![Location finder screen](/glofox/markdown-docs/flows/loc-finder.png)

  * **Endpoint:** `/clients?bundle=<bundle>`
  * **Method:** `GET`
  * **Content-Type:** `application/json`



__

The base URL for this endpoint is`app.glofox.com`, which differs from the standard staging or production API URLs.

## Log in (`POST`)

Use existing endpoints for end-user authentication. Use the response only to validate a username/password pair. All API requests require key and token header authentication. Do not use the JWT from the login endpoint for any subsequent API calls.

![Log in](/glofox/markdown-docs/flows/login.png)

  * **Endpoint:** `/2.0/login`
  * **Method:** `POST`
  * **Content-Type:** `application/json`



**Request Body**
    
    
    {
      "branch_id": "string",
      "login": "string",
      "password": "string"
    }

__

Important

This endpoint validates credentials only. Do not call it from client-facing apps. It may stop returning a JWT soon, and relying on that behavior could break your integration.
