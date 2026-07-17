This guide describes how to purchase **products** through the Glofox API using a cart-based flow.

When a user purchases a **membership** , they use a single RESTful endpoint, as described in [Payment collector](/glofox/flows/payment-collector). Product purchases follow a structured multi-step flow: list products, create a cart, then check out.

## API flow overview

The flow uses standard HTTP methods and resource-based URLs. It consists of **three sequential steps** , each with its own endpoint:

  1. **Get products** —Retrieve available products for a specific location.
  2. **Create cart** —Initialize a cart with selected products and payment method; the response includes a price breakdown.
  3. **Checkout cart** —Finalize the cart, trigger payment, and generate an invoice.



## API flow details

Step | Method | Endpoint | API Reference  
---|---|---|---  
Get products | `GET` | `/v3.0/locations/{location_id}/products` | [Get products](https://api-portal.glofox.com/api-portal/glofox/api/openapi-reference.html#tag/Products/operation/get-products)  
Create cart | `POST` | `/v3.0/carts` | [Create cart](https://api-portal.glofox.com/api-portal/glofox/api/openapi-reference.html#tag/Cart/paths/~1v3.0~1carts/post)  
Checkout cart | `POST` | `/v3.0/carts/{cart_id}/checkout` | [Checkout cart](https://api-portal.glofox.com/api-portal/glofox/api/openapi-reference.html#tag/Cart/paths/~1v3.0~1carts~1%7BcartID%7D~1checkout/post)  
  
The diagram below illustrates the sequential steps in the product purchase flow.

flowchart LR USR([User]) subgraph gfapi["ABC GLOFOX API"] direction LR S1(["1. Get products | GET /v3.0/locations/{location_id}/products"]) S2(["2. Create cart | POST /v3.0/carts"]) S3(["3. Checkout cart | POST /v3.0/carts/{cart_id}/checkout"]) S1 --- S2 --- S3 end USR --- S1

## Cart ownership and checkout authorization

A cart is always tied to the **authenticated user who created it**. Only that user can check out that cart.

Authentication for these calls uses the `x-glofox-impersonated-member-id` request header to identify the member the operation is for. That prevents one user from checking out another user’s cart.

Glofox API endpoints already support this header. It's used in other flows such as [Bookings workflow](/glofox/flows/book) and in cart **pre-checkout** for membership price breakdown, as described in [Payment collector](/glofox/flows/payment-collector).

## Restrictions

  * No mixed purchases: You can't combine product and membership in a single cart transaction. For example, buying a product and a membership together isn't supported.
  * Consistent payment processing: These cart endpoints use the same payment processing stack as the existing purchase flows elsewhere in the API.



## Final notes

Follow the cart-based sequence and the authentication rules so that checkout stays consistent and secure. For request and response shapes, use the OpenAPI specification in the [API Reference](https://api-portal.glofox.com/api-portal/glofox/api/openapi-reference.html) section of this portal, or contact [Glofox API support](mailto:glofox.apisupport@abcfitness.com) if you need help.
